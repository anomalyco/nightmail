use crate::{
    fetch, search,
    session::{Action, Identity, Protocol, Reply, decode64},
    store::{Change, Date, Error, Flags, Folder, FolderOp, MailStore, Mode, Quota},
    wire,
};
use imap_codec::imap_types::{
    auth::AuthMechanism,
    command::{CommandBody as C, FetchModifier, SelectParameter, StoreModifier},
    extensions::binary::LiteralOrLiteral8,
    fetch::{MacroOrMessageDataItemNames as Items, MessageDataItemName as Item},
    flag::{StoreResponse, StoreType},
    mailbox::{ListMailbox, Mailbox},
    sequence::SequenceSet,
    status::StatusDataItemName as Status,
};
use std::collections::BTreeMap;
const FLAGS: &str = "\\Answered \\Flagged \\Deleted \\Seen \\Draft";
/// A FETCH response is handed to the store to send once it holds this much.
const FLUSH: usize = 256 << 10;
/// What one SEARCH may read of headers and bodies, counted per scan.
const SEARCH_BYTES: usize = 256 << 20;
fn path<'a>(m: &'a Mailbox<'_>) -> Result<&'a str, Error> {
    match m {
        Mailbox::Inbox => Ok("INBOX"),
        Mailbox::Other(x) => str::from_utf8(x.as_ref()).map_err(|_| Error::Denied),
    }
}
struct Selected {
    path: String,
    validity: u32,
    ro: bool,
    view: Vec<(u32, u64)>,
    keywords: Flags,
    announced: u64,
    synced: u64,
}
impl Selected {
    fn announce_flags(&mut self, f: &Folder, r: &mut Reply, force: bool) {
        if !force && self.announced == f.highest {
            return;
        }
        self.announced = f.highest;
        let before = self.keywords.len();
        for e in &f.entries {
            self.keywords
                .extend(e.flags.iter().filter(|k| !k.starts_with('\\')).cloned());
        }
        if force || before != self.keywords.len() {
            r.line(format!(
                "* FLAGS ({}{})",
                FLAGS,
                self.keywords
                    .iter()
                    .map(|k| format!(" {k}"))
                    .collect::<String>()
            ))
        }
    }
    fn targets(&self, set: &SequenceSet, uid: bool) -> Vec<u32> {
        let last = if uid {
            self.view.last().map_or(0, |p| p.0)
        } else {
            self.view.len() as u32
        };
        use imap_codec::imap_types::sequence::{SeqOrUid, Sequence};
        let v = |x: SeqOrUid| match x {
            SeqOrUid::Asterisk => last,
            SeqOrUid::Value(n) => n.get(),
        };
        let mut ranges = set
            .0
            .as_ref()
            .iter()
            .map(|s| match *s {
                Sequence::Single(a) => (v(a), v(a)),
                Sequence::Range(a, b) => (v(a).min(v(b)), v(a).max(v(b))),
            })
            .collect::<Vec<_>>();
        ranges.sort_unstable();
        let mut result = Vec::new();
        let mut prior = 0usize;
        for (a, b) in ranges {
            let (lo, hi) = if uid {
                (
                    self.view.partition_point(|x| x.0 < a),
                    self.view.partition_point(|x| x.0 <= b),
                )
            } else {
                (
                    a.saturating_sub(1) as usize,
                    (b as usize).min(self.view.len()),
                )
            };
            let start = lo.max(prior);
            if start < hi {
                result.extend(self.view[start..hi].iter().map(|x| x.0));
                prior = hi;
            }
        }
        result
    }
}
pub struct Imap {
    tls: bool,
    pub authenticated: bool,
    selected: Option<Selected>,
    idle: Option<String>,
    sasl: Option<String>,
    /// A BYE found while a command ran; sent after that command's tagged response.
    bye: Option<Vec<u8>>,
    /// RFC 7162: after a CONDSTORE enabling command, every untagged FETCH carries UID and MODSEQ; once QRESYNC is
    /// enabled, expunges are reported as VANISHED.
    condstore: bool,
    qresync: bool,
}
impl Imap {
    pub fn new(tls: bool) -> Self {
        Self {
            tls,
            authenticated: false,
            selected: None,
            idle: None,
            sasl: None,
            bye: None,
            condstore: false,
            qresync: false,
        }
    }
    pub fn idling(&self) -> bool {
        self.idle.is_some()
    }
    pub fn capabilities(&self) -> String {
        format!(
            "IMAP4rev1 IDLE UIDPLUS MOVE SPECIAL-USE LITERAL+ NAMESPACE ENABLE UNSELECT ID LIST-EXTENDED ESEARCH LIST-STATUS CONDSTORE QRESYNC QUOTA QUOTA=RES-STORAGE QUOTA=RES-MESSAGE APPENDLIMIT={}{}",
            wire::MAX_APPEND,
            if !self.tls {
                " STARTTLS LOGINDISABLED"
            } else if !self.authenticated {
                " AUTH=PLAIN SASL-IR"
            } else {
                ""
            }
        )
    }
    fn login(&mut self, t: &str, ok: bool) -> Reply {
        self.authenticated = ok;
        let mut r = Reply::one(&if ok {
            format!("{t} OK [CAPABILITY {}] Authenticated", self.capabilities())
        } else {
            format!("{t} NO [AUTHENTICATIONFAILED] Authentication failed")
        });
        r.action = if ok { Action::Login } else { Action::Failure };
        r
    }
    /// Add an update to a command's reply. If it ends the session (the selected folder
    /// vanished while the command ran, which a refreshed Remote snapshot can reveal), the
    /// command still completes and the BYE follows its tagged response, then the connection
    /// closes: no tagged response after BYE, no open connection after it (RFC 3501 7.1.5).
    fn merge(&mut self, store: &dyn MailStore, r: &mut Reply) {
        let u = self.update(store);
        if u.action == Action::Close {
            self.bye = Some(u.bytes)
        } else {
            r.bytes.extend(u.bytes)
        }
    }
    pub fn update(&mut self, store: &dyn MailStore) -> Reply {
        let mut r = Reply::default();
        let Some(s) = &mut self.selected else {
            return r;
        };
        let Ok(f) = store.folder(&s.path).and_then(|f| {
            if f.validity == s.validity {
                Ok(f)
            } else {
                Err(Error::Missing)
            }
        }) else {
            r.line("* BYE [ALERT] Selected mailbox no longer exists");
            r.action = Action::Close;
            return r;
        };
        if s.synced == f.highest {
            return r;
        }
        s.synced = f.highest;
        s.announce_flags(f, &mut r, false);
        let entries: BTreeMap<_, _> = f.entries.iter().map(|e| (e.uid, e)).collect();
        let mut i = 0;
        // With QRESYNC the expunged UIDs go first, in one VANISHED, and the FETCHes follow with the new numbers.
        let mut gone = vec![];
        let mut changed = Reply::default();
        let (condstore, qresync) = (self.condstore, self.qresync);
        s.view.retain_mut(|(uid, modseq)| {
            if let Some(e) = entries.get(uid) {
                i += 1;
                if e.modseq != *modseq {
                    let line = format!(
                        "* {i} FETCH (UID {uid} FLAGS ({}){})",
                        fetch::flags(&e.flags),
                        if condstore {
                            format!(" MODSEQ ({})", e.modseq)
                        } else {
                            String::new()
                        }
                    );
                    if qresync {
                        changed.line(line)
                    } else {
                        r.line(line)
                    }
                    *modseq = e.modseq
                }
                true
            } else {
                if qresync {
                    gone.push(*uid)
                } else {
                    r.line(format!("* {} EXPUNGE", i + 1));
                }
                false
            }
        });
        if !gone.is_empty() {
            r.line(format!("* VANISHED {}", set(&runs(&gone))))
        }
        r.bytes.extend(changed.bytes);
        let n = s.view.len();
        s.view
            .extend(f.entries[n..].iter().map(|e| (e.uid, e.modseq)));
        if s.view.len() != n {
            r.line(format!("* {} EXISTS", s.view.len()))
        }
        r
    }
    pub fn step(
        &mut self,
        bytes: &[u8],
        account: &dyn Identity,
        store: &mut dyn MailStore,
        now: Date,
    ) -> Reply {
        if let Some(t) = self.idle.take() {
            return Reply::one(&format!(
                "{t} {}",
                if bytes.eq_ignore_ascii_case(b"DONE\r\n") {
                    "OK IDLE ended"
                } else {
                    "BAD Expected DONE"
                }
            ));
        }
        if let Some(t) = self.sasl.take() {
            if bytes == b"*\r\n" {
                return Reply::one(&format!("{t} BAD Cancelled"));
            }
            return self.login(
                &t,
                decode64(bytes.strip_suffix(b"\r\n").unwrap_or_default())
                    .is_some_and(|v| account.plain(Protocol::Imap, &v)),
            );
        }
        let (plain, ret) = cut_return(bytes).unwrap_or_default();
        let cmd = wire::imap(if plain.is_empty() { bytes } else { &plain });
        let Ok(cmd) = cmd else {
            return Reply::one(&format!(
                "{} BAD Invalid command",
                wire::tag(bytes).unwrap_or("*")
            ));
        };
        let t = cmd.tag.inner();
        let c = cmd.body;
        let mut r = Reply::default();
        let ok = |r: &mut Reply| r.line(format!("{t} OK Completed"));
        match &c {
            C::Capability => {
                r.line(format!("* CAPABILITY {}", self.capabilities()));
                ok(&mut r)
            }
            C::Logout => {
                r.line("* BYE Logging out");
                ok(&mut r);
                r.action = Action::Close
            }
            C::StartTLS if !self.tls => {
                r.line(format!("{t} OK Begin TLS"));
                r.action = Action::Upgrade
            }
            C::Noop => {
                r = self.update(store);
                if r.action != Action::Close {
                    ok(&mut r)
                }
            }
            _ if !self.tls => r.line(format!("{t} NO [PRIVACYREQUIRED] Start TLS first")),
            C::Id { .. } => {
                r.line("* ID (\"name\" \"Nightmail\")");
                ok(&mut r)
            }
            C::Login { username, password } if !self.authenticated => {
                return self.login(
                    t,
                    account.login(
                        Protocol::Imap,
                        username.as_ref(),
                        password.declassify().as_ref(),
                    ),
                );
            }
            C::Authenticate {
                mechanism: AuthMechanism::Plain,
                initial_response,
            } if !self.authenticated => {
                if let Some(s) = initial_response {
                    return self.login(t, account.plain(Protocol::Imap, s.declassify()));
                }
                self.sasl = Some(t.into());
                r.line("+ ")
            }
            _ if !self.authenticated => r.line(format!("{t} BAD Authenticate first")),
            _ => {
                if let Some(s) = &self.selected
                    && !store
                        .folder(&s.path)
                        .is_ok_and(|f| f.validity == s.validity)
                {
                    return self.update(store);
                }
                match self.command(t, &c, store, now, &mut r, &ret) {
                    Ok(Some(code)) if code.is_empty() => ok(&mut r),
                    Ok(Some(code)) => r.line(format!("{t} OK {code} Completed")),
                    Ok(None) => (),
                    Err(Error::Denied) => r.line(format!(
                        "{t} BAD Not permitted in this state or unsupported"
                    )),
                    Err(e) => r.line(format!("{t} NO {e}")),
                }
                if let Some(bye) = self.bye.take() {
                    r.bytes.extend(bye);
                    r.action = Action::Close;
                }
            }
        }
        r
    }
    fn command(
        &mut self,
        t: &str,
        c: &C<'_>,
        s: &mut dyn MailStore,
        now: Date,
        r: &mut Reply,
        ret: &Return,
    ) -> Result<Option<String>, Error> {
        let mut code = String::new();
        match c {
            C::Namespace => r.line("* NAMESPACE ((\"\" \"/\")) NIL NIL"),
            C::Enable { capabilities } if self.selected.is_none() => {
                // RFC 5161: only what this command turned on. QRESYNC implies CONDSTORE (RFC 7162 3.2.3).
                let mut on = String::new();
                for c in capabilities.as_ref() {
                    let name = c.to_string().to_ascii_uppercase();
                    let flag = match name.as_str() {
                        "CONDSTORE" => &mut self.condstore,
                        "QRESYNC" => &mut self.qresync,
                        _ => continue,
                    };
                    if !std::mem::replace(flag, true) {
                        on.push(' ');
                        on.push_str(&name)
                    }
                }
                self.condstore |= self.qresync;
                r.line(format!("* ENABLED{on}"))
            }
            C::Idle => {
                let updates = self.update(s);
                r.bytes.extend(updates.bytes);
                self.idle = Some(t.into());
                r.line("+ idling");
                return Ok(None);
            }
            C::List {
                reference,
                mailbox_wildcard,
            }
            | C::Lsub {
                reference,
                mailbox_wildcard,
            } => {
                s.list_fresh()?;
                let lsub = matches!(c, C::Lsub { .. });
                let kind = if lsub { "LSUB" } else { "LIST" };
                let pat = match mailbox_wildcard {
                    ListMailbox::String(x) => x.as_ref(),
                    ListMailbox::Token(x) => x.as_ref(),
                };
                if !lsub && let Some(o) = &ret.list {
                    let patterns = o.patterns.clone().unwrap_or_else(|| vec![pat.to_vec()]);
                    list_extended(&*s, path(reference)?.as_bytes(), &patterns, o, r)?
                } else if pat.is_empty() {
                    r.line(format!("* {kind} (\\Noselect) \"/\" \"\""))
                } else {
                    let pat = [path(reference)?.as_bytes(), pat].concat();
                    let names = s.folders();
                    let glob = widest(&pat);
                    let head = glob.iter().take_while(|c| !WILD.contains(c)).count();
                    let listed: usize = names.iter().map(|n| n.len() + 1).sum();
                    if (glob.len() - head).saturating_mul(listed) > LIST_WORK {
                        return Err(Error::Limit);
                    }
                    for name in &names {
                        let f = s.folder(name)?;
                        let parent = lsub
                            && !f.subscribed
                            && pat.ends_with(b"%")
                            && names.iter().any(|p| {
                                p.strip_prefix(name).is_some_and(|s| s.starts_with('/'))
                                    && s.folder(p).is_ok_and(|f| f.subscribed)
                            });
                        if (!lsub || f.subscribed || parent) && wildcard(&glob, name.as_bytes()) {
                            r.line(format!(
                                "* {kind} ({}) \"/\" {}",
                                if parent {
                                    "\\Noselect"
                                } else {
                                    f.role.unwrap_or("")
                                },
                                fetch::quoted(name)
                            ))
                        }
                    }
                }
            }
            C::Create { mailbox } => {
                s.edit_folder(path(mailbox)?.trim_end_matches('/'), FolderOp::Create)?
            }
            C::Delete { mailbox } => s.edit_folder(path(mailbox)?, FolderOp::Delete)?,
            C::Rename { from, to } => s.edit_folder(path(from)?, FolderOp::Rename(path(to)?))?,
            C::Subscribe { mailbox } | C::Unsubscribe { mailbox } => s.edit_folder(
                path(mailbox)?,
                FolderOp::Subscribe(matches!(c, C::Subscribe { .. })),
            )?,
            C::Select {
                mailbox,
                parameters,
            }
            | C::Examine {
                mailbox,
                parameters,
            } => {
                let mut resync = None;
                for param in parameters {
                    match param {
                        SelectParameter::CondStore => self.condstore = true,
                        // RFC 7162 3.2.5: QRESYNC only after ENABLE QRESYNC.
                        SelectParameter::QResync { .. } if !self.qresync => {
                            return Err(Error::Denied);
                        }
                        SelectParameter::QResync {
                            uid_validity,
                            mod_sequence_value,
                            known_uids,
                            ..
                        } => {
                            resync =
                                Some((uid_validity.get(), mod_sequence_value.get(), known_uids))
                        }
                    }
                }
                // RFC 7162 3.2.11: a server advertising CONDSTORE or QRESYNC marks every implicit close.
                if self.selected.is_some() {
                    r.line("* OK [CLOSED] Previous mailbox closed")
                }
                self.selected = None;
                let p = path(mailbox)?;
                s.select(p)?;
                let f = s.folder(p)?;
                let ro = matches!(c, C::Examine { .. });
                r.line(format!(
                    "* OK [PERMANENTFLAGS ({})] Flags",
                    if ro {
                        String::new()
                    } else {
                        format!("{FLAGS} \\*")
                    }
                ));
                r.line(format!("* {} EXISTS", f.entries.len()));
                r.line("* 0 RECENT");
                if let Some(i) = f.entries.iter().position(|e| !e.flags.contains("\\Seen")) {
                    r.line(format!("* OK [UNSEEN {}] First unseen", i + 1))
                }
                r.line(format!("* OK [UIDVALIDITY {}] Validity", f.validity));
                r.line(format!("* OK [UIDNEXT {}] Next UID", f.next));
                if self.condstore {
                    r.line(format!("* OK [HIGHESTMODSEQ {}] Highest", f.highest))
                }
                code = if ro { "[READ-ONLY]" } else { "[READ-WRITE]" }.into();
                let mut selected = Selected {
                    path: p.into(),
                    validity: f.validity,
                    ro,
                    view: f.entries.iter().map(|e| (e.uid, e.modseq)).collect(),
                    keywords: Flags::new(),
                    announced: 0,
                    synced: f.highest,
                };
                selected.announce_flags(f, r, true);
                // RFC 7162 3.2.5: what changed since the client's MODSEQ, as UID FETCH known-uids (FLAGS)
                // (CHANGEDSINCE modseq VANISHED) would answer. A different UIDVALIDITY is a plain SELECT.
                if let Some((validity, since, known)) = resync
                    && validity == f.validity
                {
                    let want = known
                        .as_ref()
                        .map_or_else(|| vec![(1, u32::MAX)], |k| uid_runs(k, u32::MAX));
                    if let Some(line) = earlier(&*s, p, f, &selected.view, since, &want)? {
                        r.line(line)
                    }
                    for (i, e) in f.entries.iter().enumerate() {
                        if e.modseq > since && within(&want, e.uid) {
                            r.line(format!(
                                "* {} FETCH (UID {} FLAGS ({}) MODSEQ ({}))",
                                i + 1,
                                e.uid,
                                fetch::flags(&e.flags),
                                e.modseq
                            ));
                            if r.bytes.len() >= FLUSH {
                                s.flush(&mut r.bytes)?;
                            }
                        }
                    }
                }
                self.selected = Some(selected);
            }
            C::Status {
                mailbox,
                item_names,
            } => {
                if item_names.contains(&Status::HighestModSeq) {
                    enable_condstore(&mut self.condstore, self.selected.as_ref(), r)
                }
                let p = path(mailbox)?;
                let f = s.folder(p)?;
                let deleted = if wants_deleted(item_names) {
                    s.deleted(p)?
                } else {
                    None
                };
                r.line(status_line(p, f, item_names, deleted))
            }
            // RFC 9208: one quota root, "", for the whole inbox. A store that can't tell has none.
            C::GetQuotaRoot { mailbox } => {
                let p = path(mailbox)?;
                match s.quota()? {
                    Some(q) => {
                        r.line(format!("* QUOTAROOT {} \"\"", fetch::quoted(p)));
                        r.line(quota_line(&q))
                    }
                    None => r.line(format!("* QUOTAROOT {}", fetch::quoted(p))),
                }
            }
            C::GetQuota { root } => match s.quota()? {
                Some(q) if root.as_ref().is_empty() => r.line(quota_line(&q)),
                _ => {
                    r.line(format!("{t} NO [NONEXISTENT] No such quota root"));
                    return Ok(None);
                }
            },
            C::SetQuota { .. } => {
                r.line(format!("{t} NO [CANNOT] Quotas can't be changed here"));
                return Ok(None);
            }
            C::Append {
                mailbox,
                flags,
                date,
                message,
                ..
            } => {
                let LiteralOrLiteral8::Literal(data) = message else {
                    return Err(Error::Denied);
                };
                let path = path(mailbox)?;
                if s.folder(path).is_err() {
                    r.line(format!("{t} NO [TRYCREATE] No such mailbox"));
                    return Ok(None);
                }
                let a = s.change(
                    path,
                    Change::Append {
                        raw: data.as_ref(),
                        date: date.as_ref().map_or(now, |d| *d.as_ref()),
                        flags: flags.iter().map(ToString::to_string).collect(),
                        source: crate::store::Origin::Client { now },
                    },
                )?;
                code = format!("[APPENDUID {} {}]", a.validity, a.pairs[0].1);
                self.merge(s, r)
            }
            _ => {
                let sel = self.selected.as_mut().ok_or(Error::Denied)?;
                let p = sel.path.clone();
                sel.announce_flags(s.folder(&p)?, r, false);
                let ro = sel.ro;
                let write = || if ro { Err(Error::Denied) } else { Ok(()) };
                match c {
                    C::Unselect | C::Close => {
                        if matches!(c, C::Close) && !ro {
                            s.change(&p, Change::Expunge(None))?;
                        }
                        self.selected = None
                    }
                    C::Check => self.merge(s, r),
                    C::Fetch {
                        sequence_set,
                        macro_or_item_names,
                        uid,
                        modifiers,
                    } => {
                        let mut since = None;
                        let mut vanished = false;
                        for m in modifiers {
                            match m {
                                FetchModifier::ChangedSince(n) => since = Some(n.get()),
                                FetchModifier::Vanished => vanished = true,
                            }
                        }
                        // RFC 7162 3.2.6: VANISHED only on UID FETCH with CHANGEDSINCE, after ENABLE QRESYNC.
                        if vanished && !(*uid && since.is_some() && self.qresync) {
                            return Err(Error::Denied);
                        }
                        let mut uids = sel.targets(sequence_set, *uid);
                        let mut items = match macro_or_item_names {
                            Items::Macro(m) => m.expand(),
                            Items::MessageDataItemNames(v) => v.clone(),
                        };
                        if *uid && !items.contains(&Item::Uid) {
                            items.push(Item::Uid)
                        }
                        if since.is_some() || items.contains(&Item::ModSeq) {
                            enable_condstore(&mut self.condstore, Some(&*sel), r)
                        }
                        if let Some(n) = since {
                            let f = s.folder(&p)?;
                            uids.retain(|u| {
                                f.entries
                                    .binary_search_by_key(u, |e| e.uid)
                                    .is_ok_and(|j| f.entries[j].modseq > n)
                            });
                            if vanished {
                                let star = sel.view.last().map_or(0, |v| v.0);
                                let want = uid_runs(sequence_set, star);
                                if let Some(line) = earlier(&*s, &p, f, &sel.view, n, &want)? {
                                    r.line(line)
                                }
                            }
                        }
                        let seen = !ro
                            && items.iter().any(|i| {
                                matches!(
                                    i,
                                    Item::Rfc822
                                        | Item::Rfc822Text
                                        | Item::BodyExt { peek: false, .. }
                                )
                            });
                        if seen {
                            let unseen: Vec<_> = s
                                .folder(&p)?
                                .entries
                                .iter()
                                .filter(|e| {
                                    uids.binary_search(&e.uid).is_ok()
                                        && !e.flags.contains("\\Seen")
                                })
                                .map(|e| e.uid)
                                .collect();
                            if !unseen.is_empty() {
                                s.change(
                                    &p,
                                    Change::Flags(
                                        &unseen,
                                        Mode::Add,
                                        Flags::from(["\\Seen".into()]),
                                        None,
                                    ),
                                )?;
                                if !items.contains(&Item::Flags) {
                                    items.push(Item::Flags)
                                }
                                if self.condstore && !items.contains(&Item::Uid) {
                                    items.push(Item::Uid)
                                }
                            }
                        }
                        // CHANGEDSINCE implies MODSEQ, and once CONDSTORE is on, flags carry theirs.
                        if (since.is_some() || (self.condstore && items.contains(&Item::Flags)))
                            && !items.contains(&Item::ModSeq)
                        {
                            items.push(Item::ModSeq)
                        }
                        let f = s.folder(&p)?;
                        let meta_only = items.iter().all(|x| {
                            matches!(
                                x,
                                Item::Flags
                                    | Item::Uid
                                    | Item::ModSeq
                                    | Item::InternalDate
                                    | Item::Rfc822Size
                            )
                        });
                        let mut next_page = 0;
                        for (at, u) in uids.iter().enumerate() {
                            if !meta_only && uids.len() > 8 && at == next_page {
                                next_page += s.prefetch(&p, &uids[at..uids.len().min(at + 256)])?;
                            }
                            if let Ok(i) = sel.view.binary_search_by_key(u, |v| v.0)
                                && let Ok(j) = f.entries.binary_search_by_key(u, |e| e.uid)
                            {
                                let e = &f.entries[j];
                                s.budget()?;
                                let loaded;
                                let e = if items.iter().all(|x| {
                                    matches!(
                                        x,
                                        Item::Flags
                                            | Item::Uid
                                            | Item::ModSeq
                                            | Item::InternalDate
                                            | Item::Rfc822Size
                                    )
                                }) {
                                    e
                                } else {
                                    let header_only=items.iter().all(|x|matches!(x,Item::Flags|Item::Uid|Item::ModSeq|Item::InternalDate|Item::Rfc822Size|Item::Envelope|Item::Rfc822Header|Item::BodyExt{section:Some(imap_codec::imap_types::fetch::Section::Header(None)|imap_codec::imap_types::fetch::Section::HeaderFields(None,_)|imap_codec::imap_types::fetch::Section::HeaderFieldsNot(None,_)),..}));
                                    loaded = if header_only {
                                        s.header(&p, e)?
                                    } else {
                                        s.materialize(&p, e)?
                                    };
                                    &loaded
                                };
                                if let Err(err) = fetch::render(&mut r.bytes, i + 1, e, &items) {
                                    r.bytes.clear();
                                    r.line(format!("{t} NO {err}"));
                                    return Ok(None);
                                }
                                if items.contains(&Item::Flags) {
                                    sel.view[i].1 = e.modseq
                                }
                                // Send a long response as it is built, one message at a time, rather than
                                // holding all of it (MailStore::flush).
                                if r.bytes.len() >= FLUSH {
                                    s.flush(&mut r.bytes)?;
                                }
                            }
                        }
                    }
                    C::Store {
                        sequence_set,
                        kind,
                        response,
                        flags,
                        uid,
                        modifiers,
                    } => {
                        write()?;
                        let mut uids = sel.targets(sequence_set, *uid);
                        // RFC 7162 3.1.3: UNCHANGEDSINCE leaves the messages changed since alone and names
                        // them in MODIFIED.
                        let mut modified = vec![];
                        let unchanged_since = modifiers
                            .iter()
                            .map(|StoreModifier::UnchangedSince(n)| *n)
                            .next();
                        if let Some(n) = unchanged_since {
                            enable_condstore(&mut self.condstore, Some(&*sel), r);
                            let f = s.folder(&p)?;
                            uids.retain(|u| {
                                let changed = f
                                    .entries
                                    .binary_search_by_key(u, |e| e.uid)
                                    .is_ok_and(|j| f.entries[j].modseq > n);
                                if changed {
                                    modified.push(if *uid {
                                        *u
                                    } else {
                                        sel.view
                                            .binary_search_by_key(u, |v| v.0)
                                            .map_or(0, |i| i as u32 + 1)
                                    })
                                }
                                !changed
                            });
                        }
                        let applied = s.change(
                            &p,
                            Change::Flags(
                                &uids,
                                match kind {
                                    StoreType::Add => Mode::Add,
                                    StoreType::Remove => Mode::Remove,
                                    StoreType::Replace => Mode::Replace,
                                },
                                flags.iter().map(ToString::to_string).collect(),
                                unchanged_since,
                            ),
                        );
                        // A large STORE goes in batches. If it stops partway, report the
                        // targets whose flags did change (their MODSEQ moved), then NO.
                        let partial = matches!(applied, Err(Error::Partial));
                        // The store checks UNCHANGEDSINCE again as it applies the change, so a
                        // change from another session in between is MODIFIED too.
                        let left = match applied {
                            Ok(a) => a.modified,
                            Err(Error::Partial) => vec![],
                            Err(e) => return Err(e),
                        };
                        if !left.is_empty() {
                            uids.retain(|u| !left.contains(u));
                            modified.extend(left.iter().map(|u| {
                                if *uid {
                                    *u
                                } else {
                                    sel.view
                                        .binary_search_by_key(u, |v| v.0)
                                        .map_or(0, |i| i as u32 + 1)
                                }
                            }));
                            modified.sort_unstable();
                        }
                        let f = s.folder(&p)?;
                        sel.announce_flags(f, r, false);
                        let condstore = self.condstore;
                        for (i, (u, ms)) in sel.view.iter_mut().enumerate() {
                            if uids.binary_search(u).is_ok()
                                && let Ok(j) = f.entries.binary_search_by_key(u, |e| e.uid)
                            {
                                let e = &f.entries[j];
                                // .SILENT leaves the recorded MODSEQ alone, so the next update
                                // reports the merged flags, including another session's earlier
                                // change (RFC 3501 6.4.6). With CONDSTORE it still answers the
                                // MODSEQ (RFC 7162 3.1.3).
                                let answer = *response == StoreResponse::Answer;
                                if (answer || condstore) && (!partial || e.modseq != *ms) {
                                    let mut data = vec![];
                                    if *uid || condstore {
                                        data.push(format!("UID {u}"))
                                    }
                                    if answer {
                                        *ms = e.modseq;
                                        data.push(format!("FLAGS ({})", fetch::flags(&e.flags)))
                                    }
                                    if condstore {
                                        data.push(format!("MODSEQ ({})", e.modseq))
                                    }
                                    r.line(format!("* {} FETCH ({})", i + 1, data.join(" ")))
                                }
                            }
                        }
                        if partial {
                            return Err(Error::Partial);
                        }
                        if !modified.is_empty() {
                            code = format!("[MODIFIED {}]", set(&runs(&modified)))
                        }
                    }
                    C::Search {
                        criteria,
                        charset,
                        uid,
                    } => {
                        if !criteria.as_ref().iter().all(search::bounded) {
                            return Err(Error::Limit);
                        }
                        let modseq_key = criteria.as_ref().iter().any(search::has_modseq);
                        if modseq_key {
                            enable_condstore(&mut self.condstore, Some(&*sel), r)
                        }
                        // RFC 7162 3.1.6 and 3.1.10: a MODSEQ criterion adds the highest MODSEQ of the
                        // messages answered; with only MIN or MAX, of those.
                        let answer = |found: Vec<u32>, f: &Folder| {
                            let modseq = |n: &u32| {
                                let u = if *uid {
                                    *n
                                } else {
                                    sel.view.get((*n as usize).checked_sub(1)?)?.0
                                };
                                let j = f.entries.binary_search_by_key(&u, |e| e.uid).ok()?;
                                Some(f.entries[j].modseq)
                            };
                            match ret.search {
                                Some(o) => {
                                    let [min, max, count, all] = o;
                                    let highest = if !modseq_key {
                                        None
                                    } else if all || count {
                                        found.iter().filter_map(modseq).max()
                                    } else {
                                        let ends = [
                                            found.iter().min().filter(|_| min),
                                            found.iter().max().filter(|_| max),
                                        ];
                                        ends.into_iter().flatten().filter_map(modseq).max()
                                    };
                                    esearch(t, *uid, found, o, highest)
                                }
                                None => {
                                    let mut line = String::from("* SEARCH");
                                    for n in &found {
                                        line.push_str(&format!(" {n}"))
                                    }
                                    if modseq_key
                                        && let Some(m) = found.iter().filter_map(modseq).max()
                                    {
                                        line.push_str(&format!(" (MODSEQ {m})"))
                                    }
                                    line
                                }
                            }
                        };
                        if charset.as_ref().is_some_and(|c| {
                            !["utf-8", "us-ascii"]
                                .iter()
                                .any(|x| c.as_ref().eq_ignore_ascii_case(x))
                        }) {
                            r.line(format!("{t} NO [BADCHARSET (UTF-8 US-ASCII)] Unsupported"));
                            return Ok(None);
                        }
                        let f = s.folder(&p)?;
                        if let [key] = criteria.as_ref()
                            && let Some((field, term)) = search::indexed(key)
                            && let Some(hits) = s.indexed(&p, field, term)?
                        {
                            let mut found = Vec::new();
                            for u in hits {
                                if let Ok(i) = sel.view.binary_search_by_key(&u, |x| x.0) {
                                    found.push(if *uid { u } else { i as u32 + 1 });
                                }
                            }
                            r.line(answer(found, f));
                            return Ok(Some(String::new()));
                        }
                        let mut terms = std::collections::BTreeSet::new();
                        if criteria.as_ref().len() > 1
                            || criteria.as_ref().iter().any(|k| {
                                matches!(
                                    k,
                                    imap_codec::imap_types::search::SearchKey::And(_)
                                        | imap_codec::imap_types::search::SearchKey::Or(..)
                                        | imap_codec::imap_types::search::SearchKey::Not(_)
                                )
                            })
                        {
                            let mut hits = BTreeMap::new();
                            if criteria
                                .as_ref()
                                .iter()
                                .all(|k| search::index_plan(k, &mut terms))
                                && !terms.is_empty()
                            {
                                for &(field, term) in &terms {
                                    if let Some(uids) = s.indexed(&p, field, term)? {
                                        hits.insert((field, term), uids);
                                    }
                                }
                                if hits.len() == terms.len() {
                                    let mut found = Vec::new();
                                    let max = sel.view.last().map_or(0, |v| v.0);
                                    for (i, (u, _)) in sel.view.iter().enumerate() {
                                        if let Ok(j) = f.entries.binary_search_by_key(u, |e| e.uid)
                                            && criteria.as_ref().iter().all(|k| {
                                                search::planned(
                                                    k,
                                                    &f.entries[j],
                                                    i as u32 + 1,
                                                    sel.view.len() as u32,
                                                    max,
                                                    &hits,
                                                )
                                            })
                                        {
                                            found.push(if *uid { *u } else { i as u32 + 1 });
                                        }
                                    }
                                    r.line(answer(found, f));
                                    return Ok(Some(String::new()));
                                }
                            }
                        }
                        let need = criteria
                            .as_ref()
                            .iter()
                            .map(search::need)
                            .max()
                            .unwrap_or_default();
                        let mut found = Vec::new();
                        let scans = criteria
                            .as_ref()
                            .iter()
                            .map(search::scan_count)
                            .sum::<usize>();
                        let mut bytes_left = SEARCH_BYTES;
                        let mut next_page = 0;
                        for (i, (u, _)) in sel.view.iter().enumerate() {
                            if need != search::Need::Meta && sel.view.len() > 8 && i == next_page {
                                let page: Vec<_> = sel.view[i..sel.view.len().min(i + 256)]
                                    .iter()
                                    .map(|x| x.0)
                                    .collect();
                                next_page += s.prefetch(&p, &page)?;
                            }
                            if let Ok(j) = f.entries.binary_search_by_key(u, |e| e.uid) {
                                s.budget()?;
                                let mem;
                                let entry = &f.entries[j];
                                if !criteria
                                    .as_ref()
                                    .iter()
                                    .filter(|k| search::need(k) == search::Need::Meta)
                                    .all(|k| {
                                        search::matches(
                                            k,
                                            entry,
                                            i as u32 + 1,
                                            sel.view.len() as u32,
                                            sel.view.last().map_or(0, |v| v.0),
                                        )
                                    })
                                {
                                    continue;
                                }
                                if need == search::Need::Body
                                    && entry.size.saturating_mul(scans) > bytes_left
                                {
                                    return Err(Error::Limit);
                                }
                                let loaded = match need {
                                    search::Need::Meta => entry,
                                    search::Need::Header => {
                                        mem = s.header(&p, entry)?;
                                        &mem
                                    }
                                    search::Need::Body => {
                                        mem = s.materialize(&p, entry)?;
                                        &mem
                                    }
                                };
                                bytes_left = bytes_left
                                    .checked_sub(loaded.raw.len().saturating_mul(scans))
                                    .ok_or(Error::Limit)?;
                                if criteria.as_ref().iter().all(|k| {
                                    search::matches(
                                        k,
                                        loaded,
                                        i as u32 + 1,
                                        sel.view.len() as u32,
                                        sel.view.last().map_or(0, |v| v.0),
                                    )
                                }) {
                                    found.push(if *uid { *u } else { i as u32 + 1 })
                                }
                            }
                        }
                        r.line(answer(found, f))
                    }
                    C::Copy {
                        sequence_set,
                        mailbox,
                        uid,
                    }
                    | C::Move {
                        sequence_set,
                        mailbox,
                        uid,
                    } => {
                        let moving = matches!(c, C::Move { .. });
                        if moving {
                            write()?
                        }
                        let to = path(mailbox)?;
                        if s.folder(to).is_err() {
                            r.line(format!("{t} NO [TRYCREATE] No such mailbox"));
                            return Ok(None);
                        }
                        let shown = sel.view.len();
                        let a = match s.change(
                            &p,
                            Change::Transfer(&sel.targets(sequence_set, *uid), to, moving),
                        ) {
                            // Batches committed before the failure: report them (EXISTS,
                            // EXPUNGE), then NO. COPYUID belongs to a completed COPY only.
                            Err(Error::Partial) => {
                                self.merge(s, r);
                                return Err(Error::Partial);
                            }
                            other => other?,
                        };
                        if !a.pairs.is_empty() {
                            let csv = |dst: bool| {
                                a.pairs
                                    .iter()
                                    .map(|(x, y)| if dst { y } else { x }.to_string())
                                    .collect::<Vec<_>>()
                                    .join(",")
                            };
                            code = format!("[COPYUID {} {} {}]", a.validity, csv(false), csv(true));
                            if moving {
                                r.line(format!("* OK {code} Moved"));
                                code.clear()
                            }
                        }
                        self.merge(s, r);
                        // As for EXPUNGE (RFC 7162 3.2.7): with QRESYNC, a MOVE answers the new HIGHESTMODSEQ.
                        if moving
                            && self.qresync
                            && let Some(sel) = &self.selected
                            && sel.view.len() < shown
                        {
                            code = format!("[HIGHESTMODSEQ {}]", sel.synced)
                        }
                    }
                    C::Expunge | C::ExpungeUid { .. } => {
                        write()?;
                        let uids = if let C::ExpungeUid { sequence_set } = c {
                            Some(sel.targets(sequence_set, true))
                        } else {
                            None
                        };
                        let shown = sel.view.len();
                        // Batches that committed before a failure are reported, then NO.
                        let applied = s.change(&p, Change::Expunge(uids.as_deref()));
                        if matches!(applied, Ok(_) | Err(Error::Partial)) {
                            self.merge(s, r);
                        }
                        applied?;
                        // RFC 7162 3.2.7: with QRESYNC, an expunge answers the new HIGHESTMODSEQ.
                        if self.qresync
                            && let Some(sel) = &self.selected
                            && sel.view.len() < shown
                        {
                            code = format!("[HIGHESTMODSEQ {}]", sel.synced)
                        }
                    }
                    _ => return Err(Error::Denied),
                }
            }
        }
        Ok(Some(code))
    }
}
/// One STATUS item. `deleted`: the store's own count of a folder's \Deleted messages and their bytes, for a folder
/// whose messages it doesn't hold (MailStore::deleted).
fn status(f: &Folder, s: &Status, deleted: Option<(u64, u64)>) -> String {
    let marked = || f.entries.iter().filter(|e| e.flags.contains("\\Deleted"));
    let (name, n) = match s {
        Status::Messages => ("MESSAGES", f.counts.map_or(f.entries.len(), |c| c.0)),
        Status::Unseen if f.counts.is_some() => ("UNSEEN", f.counts.map_or(0, |c| c.1)),
        Status::Unseen => (
            "UNSEEN",
            f.entries
                .iter()
                .filter(|e| !e.flags.contains("\\Seen"))
                .count(),
        ),
        Status::Recent => ("RECENT", 0),
        Status::Deleted => (
            "DELETED",
            deleted.map_or_else(|| marked().count(), |d| d.0 as usize),
        ),
        // RFC 9208 4.1.4: in KiB, the RFC822.SIZE of the \Deleted messages.
        Status::DeletedStorage => (
            "DELETED-STORAGE",
            deleted
                .map_or_else(|| marked().map(|e| e.size).sum(), |d| d.1 as usize)
                .div_ceil(1024),
        ),
        Status::UidValidity => ("UIDVALIDITY", f.validity as usize),
        Status::UidNext => ("UIDNEXT", f.next as usize),
        Status::HighestModSeq => ("HIGHESTMODSEQ", f.highest as usize),
    };
    format!("{name} {n}")
}
fn wants_deleted(items: &[Status]) -> bool {
    items
        .iter()
        .any(|i| matches!(i, Status::Deleted | Status::DeletedStorage))
}
fn status_line(p: &str, f: &Folder, items: &[Status], deleted: Option<(u64, u64)>) -> String {
    let fields = items
        .iter()
        .map(|item| status(f, item, deleted))
        .collect::<Vec<_>>()
        .join(" ");
    format!("* STATUS {} ({fields})", fetch::quoted(p))
}
/// Options imap-codec doesn't decode, cut from the command before it is: ESEARCH's RETURN on SEARCH (RFC 4731), and an
/// extended LIST's selection options, patterns and RETURN options (RFC 5258; SPECIAL-USE RFC 6154, STATUS RFC 5819).
#[derive(Default)]
struct Return {
    /// MIN, MAX, COUNT and ALL.
    search: Option<[bool; 4]>,
    list: Option<ListExt>,
}
/// An extended LIST (RFC 5258). SPECIAL-USE changes nothing: LIST always shows roles.
#[derive(Default)]
struct ListExt {
    /// Selection options: SUBSCRIBED and RECURSIVEMATCH. REMOTE adds nothing here.
    subscribed: bool,
    recursive: bool,
    /// Return options: SUBSCRIBED, CHILDREN and STATUS.
    show_subscribed: bool,
    children: bool,
    status: Option<Vec<Status>>,
    /// A list of patterns; None: the command's one pattern.
    patterns: Option<Vec<Vec<u8>>>,
}
fn strip<'a>(s: &'a [u8], p: &[u8]) -> Option<&'a [u8]> {
    s.get(..p.len())
        .filter(|h| h.eq_ignore_ascii_case(p))
        .map(|_| &s[p.len()..])
}
/// The astring or list-mailbox at the start of `b`, decoded, and how many bytes it takes: a quoted string, a literal
/// or an atom (which may hold LIST wildcards).
fn token(b: &[u8]) -> Option<(std::borrow::Cow<'_, [u8]>, usize)> {
    match *b.first()? {
        b'"' => {
            let mut out = vec![];
            let mut i = 1;
            loop {
                match *b.get(i)? {
                    b'\\' => {
                        out.push(*b.get(i + 1)?);
                        i += 2
                    }
                    b'"' => return Some((out.into(), i + 1)),
                    c => {
                        out.push(c);
                        i += 1
                    }
                }
            }
        }
        b'{' => {
            let close = b.iter().position(|&c| c == b'}')?;
            let digits = b[1..close].strip_suffix(b"+").unwrap_or(&b[1..close]);
            let n: usize = str::from_utf8(digits).ok()?.parse().ok()?;
            let start = close + 3;
            if b.get(close + 1..start)? != b"\r\n" {
                return None;
            }
            let end = start.checked_add(n)?;
            Some((b.get(start..end)?.into(), end))
        }
        _ => {
            let n = b
                .iter()
                .position(|c| b" ()\"{\r\n".contains(c))
                .unwrap_or(b.len());
            (n > 0).then(|| (b[..n].into(), n))
        }
    }
}
fn cut_return(bytes: &[u8]) -> Option<(Vec<u8>, Return)> {
    let word = |at: usize| {
        let rest = bytes.get(at..)?;
        Some(&rest[..rest.iter().position(|&b| b == b' ').unwrap_or(rest.len())])
    };
    let tag = word(0)?.len() + 1;
    let uid = word(tag)?.eq_ignore_ascii_case(b"UID");
    let at = tag + if uid { 4 } else { 0 };
    let verb = word(at)?;
    let at = at + verb.len();
    let key = b" RETURN (";
    let mut ret = Return::default();
    if verb.eq_ignore_ascii_case(b"SEARCH") && strip(&bytes[at..], key).is_some() {
        let open = at + key.len();
        let close = open + bytes[open..].iter().position(|&b| b == b')')?;
        let mut opts = [false; 4];
        for o in bytes[open..close]
            .split(|&b| b == b' ')
            .filter(|o| !o.is_empty())
        {
            let names: [&[u8]; 4] = [b"MIN", b"MAX", b"COUNT", b"ALL"];
            opts[names.iter().position(|n| o.eq_ignore_ascii_case(n))?] = true;
        }
        // `RETURN ()` asks for ALL.
        if opts == [false; 4] {
            opts[3] = true
        }
        ret.search = Some(opts);
        return Some(([&bytes[..at], &bytes[close + 1..]].concat(), ret));
    }
    if !verb.eq_ignore_ascii_case(b"LIST") || uid {
        return None;
    }
    // LIST [SP "(" selection ")"] SP reference SP (pattern / "(" patterns ")") [SP RETURN (options)]
    let mut o = ListExt::default();
    let mut extended = false;
    let mut end = bytes.len().checked_sub(2)?;
    if let Some(from) = bytes
        .windows(key.len())
        .rposition(|w| w.eq_ignore_ascii_case(key))
        && let Some(mut rest) = bytes[from + key.len()..].strip_suffix(b")\r\n")
    {
        while !rest.is_empty() {
            rest = if let Some(r) = strip(rest, b"SPECIAL-USE") {
                r
            } else if let Some(r) = strip(rest, b"SUBSCRIBED") {
                o.show_subscribed = true;
                r
            } else if let Some(r) = strip(rest, b"CHILDREN") {
                o.children = true;
                r
            } else {
                let list = strip(rest, b"STATUS ")?;
                let close = list.iter().position(|&b| b == b')')? + 1;
                o.status = Some(status_items(&list[..close])?);
                &list[close..]
            };
            rest = match rest {
                [b' ', r @ ..] if !r.is_empty() => r,
                [] => rest,
                _ => return None,
            };
        }
        (end, extended) = (from, true);
    }
    let mut next = at;
    if bytes.get(at..at + 2) == Some(b" (") {
        let close = at + 2 + bytes.get(at + 2..end)?.iter().position(|&b| b == b')')?;
        for opt in bytes[at + 2..close]
            .split(|&b| b == b' ')
            .filter(|o| !o.is_empty())
        {
            if opt.eq_ignore_ascii_case(b"SUBSCRIBED") {
                o.subscribed = true
            } else if opt.eq_ignore_ascii_case(b"RECURSIVEMATCH") {
                o.recursive = true
            } else if !opt.eq_ignore_ascii_case(b"REMOTE") {
                return None;
            }
        }
        // RFC 5258 3.1: RECURSIVEMATCH refines another selection option.
        if o.recursive && !o.subscribed {
            return None;
        }
        (next, extended) = (close + 1, true);
    }
    let rest = bytes.get(next..end)?.strip_prefix(b" ")?;
    let (reference, rest) = rest.split_at(token(rest)?.1);
    let rest = rest.strip_prefix(b" ")?;
    let pattern = match rest.strip_prefix(b"(") {
        Some(mut list) => {
            let mut patterns = vec![];
            loop {
                let (p, n) = token(list)?;
                patterns.push(p.into_owned());
                list = match &list[n..] {
                    [b')'] => break,
                    [b' ', r @ ..] => r,
                    _ => return None,
                };
            }
            (o.patterns, extended) = (Some(patterns), true);
            &b"\"\""[..]
        }
        None => rest,
    };
    if !extended {
        return None;
    }
    ret.list = Some(o);
    let plain = [
        &bytes[..at],
        &b" "[..],
        reference,
        &b" "[..],
        pattern,
        &b"\r\n"[..],
    ]
    .concat();
    Some((plain, ret))
}
/// RFC 9208: STORAGE in KiB and MESSAGE, for the limits the inbox has; an empty list means none.
fn quota_line(q: &Quota) -> String {
    let mut list = vec![];
    if let Some(max) = q.max_bytes {
        list.push(format!("STORAGE {} {}", q.bytes.div_ceil(1024), max / 1024))
    }
    if let Some(max) = q.max_messages {
        list.push(format!("MESSAGE {} {max}", q.messages))
    }
    format!("* QUOTA \"\" ({})", list.join(" "))
}
/// An extended LIST (RFC 5258) over every pattern, where an empty pattern matches nothing. With RECURSIVEMATCH the
/// parents of subscribed folders are candidates too, whether or not they exist.
fn list_extended(
    s: &dyn MailStore,
    reference: &[u8],
    patterns: &[Vec<u8>],
    o: &ListExt,
    r: &mut Reply,
) -> Result<(), Error> {
    use std::{collections::BTreeSet, ops::Bound};
    let names = s.folders();
    let held: BTreeSet<&str> = names.iter().map(String::as_str).collect();
    let mut candidates = held.clone();
    if o.recursive {
        for n in &names {
            candidates.extend(n.match_indices('/').map(|(i, _)| &n[..i]));
        }
    }
    let globs: Vec<Vec<u8>> = patterns
        .iter()
        .filter(|p| !p.is_empty())
        .map(|p| widest(&[reference, p].concat()))
        .collect();
    let listed: usize = candidates.iter().map(|n| n.len() + 1).sum();
    let work: usize = globs
        .iter()
        .map(|g| g.len() - g.iter().take_while(|c| !WILD.contains(c)).count())
        .sum();
    if work.saturating_mul(listed) > LIST_WORK {
        return Err(Error::Limit);
    }
    let below = |n: &str| -> Vec<&str> {
        let (lo, hi) = (format!("{n}/"), format!("{n}0"));
        held.range::<str, _>((Bound::Included(lo.as_str()), Bound::Excluded(hi.as_str())))
            .copied()
            .collect()
    };
    for n in candidates {
        if !globs.iter().any(|g| wildcard(g, n.as_bytes())) {
            continue;
        }
        let f = if held.contains(n) {
            Some(s.folder(n)?)
        } else {
            None
        };
        let meets = f.is_some_and(|f| !o.subscribed || f.subscribed);
        let below = below(n);
        // RFC 5258 3.5: with RECURSIVEMATCH, a match with a subscribed descendant says so.
        let childinfo = o.recursive
            && below
                .iter()
                .any(|d| s.folder(d).is_ok_and(|f| f.subscribed));
        if !meets && !childinfo {
            continue;
        }
        let mut attrs = vec![];
        match f {
            Some(f) => attrs.extend(f.role),
            None => attrs.push("\\NonExistent"),
        }
        if (o.subscribed || o.show_subscribed) && f.is_some_and(|f| f.subscribed) {
            attrs.push("\\Subscribed")
        }
        if o.children {
            attrs.push(if below.is_empty() {
                "\\HasNoChildren"
            } else {
                "\\HasChildren"
            })
        }
        r.line(format!(
            "* LIST ({}) \"/\" {}{}",
            attrs.join(" "),
            fetch::quoted(n),
            if childinfo {
                " (\"CHILDINFO\" (\"SUBSCRIBED\"))"
            } else {
                ""
            }
        ));
        if meets && let (Some(f), Some(items)) = (f, &o.status) {
            let deleted = if wants_deleted(items) {
                s.deleted(n)?
            } else {
                None
            };
            r.line(status_line(n, f, items, deleted))
        }
    }
    Ok(())
}
/// A parenthesized list of STATUS data items, in the STATUS command's grammar.
fn status_items(list: &[u8]) -> Option<Vec<Status>> {
    match wire::imap(&[&b"x STATUS INBOX "[..], list, &b"\r\n"[..]].concat())
        .ok()?
        .body
    {
        C::Status { item_names, .. } => Some(item_names.into_owned()),
        _ => None,
    }
}
/// The first CONDSTORE enabling command (RFC 7162 3.1) with a mailbox selected answers its HIGHESTMODSEQ: the
/// highest this session has reported every change up to, so an update not yet sent is never skipped.
fn enable_condstore(on: &mut bool, sel: Option<&Selected>, r: &mut Reply) {
    if !std::mem::replace(on, true)
        && let Some(sel) = sel
    {
        r.line(format!("* OK [HIGHESTMODSEQ {}] Highest", sel.synced))
    }
}
/// Sorted numbers as ranges of consecutive ones.
fn runs(sorted: &[u32]) -> Vec<(u32, u32)> {
    sorted
        .chunk_by(|a, b| a.checked_add(1) == Some(*b))
        .map(|run| (run[0], run[run.len() - 1]))
        .collect()
}
/// Ranges as a sequence set: `1:3,5`.
fn set(runs: &[(u32, u32)]) -> String {
    runs.iter()
        .map(|&(a, b)| {
            if a == b {
                a.to_string()
            } else {
                format!("{a}:{b}")
            }
        })
        .collect::<Vec<_>>()
        .join(",")
}
/// A UID set as sorted, merged ranges, with `*` as `star`.
fn uid_runs(set: &SequenceSet, star: u32) -> Vec<(u32, u32)> {
    use imap_codec::imap_types::sequence::{SeqOrUid, Sequence};
    let v = |x: SeqOrUid| match x {
        SeqOrUid::Asterisk => star,
        SeqOrUid::Value(n) => n.get(),
    };
    let mut ranges: Vec<_> = set
        .0
        .as_ref()
        .iter()
        .map(|s| match *s {
            Sequence::Single(a) => (v(a), v(a)),
            Sequence::Range(a, b) => (v(a).min(v(b)), v(a).max(v(b))),
        })
        .collect();
    ranges.sort_unstable();
    let mut merged: Vec<(u32, u32)> = vec![];
    for (a, b) in ranges {
        match merged.last_mut() {
            Some(last) if a <= last.1.saturating_add(1) => last.1 = last.1.max(b),
            _ => merged.push((a, b)),
        }
    }
    merged
}
fn within(runs: &[(u32, u32)], n: u32) -> bool {
    runs.get(runs.partition_point(|r| r.1 < n))
        .is_some_and(|r| r.0 <= n)
}
/// VANISHED (EARLIER) for the UIDs in `want` expunged after `since` that this session no longer shows (RFC 7162 3.2.5,
/// 3.2.6). When the store can't tell, it names every UID in `want` below UIDNEXT that the mailbox doesn't hold, as RFC
/// 7162 3.2.6 allows a server that keeps no MODSEQ for expunged messages to.
fn earlier(
    s: &dyn MailStore,
    p: &str,
    f: &Folder,
    view: &[(u32, u64)],
    since: u64,
    want: &[(u32, u32)],
) -> Result<Option<String>, Error> {
    let mut held: Vec<u32> = view
        .iter()
        .map(|v| v.0)
        .chain(f.entries.iter().map(|e| e.uid))
        .collect();
    held.sort_unstable();
    held.dedup();
    let gone = match s.vanished(p, since)? {
        Some(mut uids) => {
            uids.sort_unstable();
            uids.dedup();
            uids.retain(|u| within(want, *u) && held.binary_search(u).is_err());
            runs(&uids)
        }
        None => {
            let top = f.next.saturating_sub(1);
            let mut gaps = vec![];
            for &(a, b) in want {
                let (mut next, b) = (a.max(1), b.min(top));
                for &u in held[held.partition_point(|&h| h < next)..]
                    .iter()
                    .take_while(|&&u| u <= b)
                {
                    if u > next {
                        gaps.push((next, u - 1))
                    }
                    next = u + 1;
                }
                if next <= b {
                    gaps.push((next, b))
                }
            }
            gaps
        }
    };
    Ok((!gone.is_empty()).then(|| format!("* VANISHED (EARLIER) {}", set(&gone))))
}
/// RFC 4731: the requested MIN, MAX, COUNT and ALL of the matches, without MIN, MAX and ALL when nothing matched, and
/// the MODSEQ a MODSEQ criterion asks for (RFC 7162 3.1.10).
fn esearch(
    t: &str,
    uid: bool,
    mut found: Vec<u32>,
    [min, max, count, all]: [bool; 4],
    modseq: Option<u64>,
) -> String {
    found.sort_unstable();
    found.dedup();
    let mut line = format!("* ESEARCH (TAG {})", fetch::quoted(t));
    if uid {
        line.push_str(" UID")
    }
    if let (Some(lo), Some(hi)) = (found.first(), found.last()) {
        if min {
            line.push_str(&format!(" MIN {lo}"))
        }
        if max {
            line.push_str(&format!(" MAX {hi}"))
        }
    }
    if count {
        line.push_str(&format!(" COUNT {}", found.len()))
    }
    if all && !found.is_empty() {
        line.push_str(&format!(" ALL {}", set(&runs(&found))))
    }
    if let Some(m) = modseq {
        line.push_str(&format!(" MODSEQ {m}"))
    }
    line
}
const WILD: &[u8] = b"*%";
/// Matching steps one LIST may spend past the pattern's literal start, across every folder:
/// its wildcard part times the bytes of all names. Folder queries sit far below it.
const LIST_WORK: usize = 1 << 20;
/// The pattern with each run of wildcards written as its widest member, which matches the same names.
fn widest(pat: &[u8]) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::new();
    for &c in pat {
        match out.last_mut() {
            Some(last) if WILD.contains(last) && WILD.contains(&c) => *last = (*last).max(c),
            _ => out.push(c),
        }
    }
    out
}
fn wildcard(pat: &[u8], name: &[u8]) -> bool {
    let head = pat.iter().take_while(|c| !WILD.contains(c)).count();
    let Some(name) = name.strip_prefix(&pat[..head]) else {
        return false;
    };
    let pat = &pat[head..];
    if pat.is_empty() {
        return name.is_empty();
    }
    let mut prev = vec![false; name.len() + 1];
    let mut next = prev.clone();
    prev[0] = true;
    for &c in pat {
        next[0] = prev[0] && WILD.contains(&c);
        let mut open = next[0];
        for (i, &b) in name.iter().enumerate() {
            next[i + 1] = match c {
                b'*' => prev[i + 1] || next[i],
                b'%' => prev[i + 1] || (b != b'/' && next[i]),
                _ => prev[i] && c == b,
            };
            open |= next[i + 1];
        }
        if !open {
            return false;
        }
        std::mem::swap(&mut prev, &mut next);
    }
    prev[name.len()]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::Account;
    use crate::store::{Applied, Memory};

    /// A store whose snapshot loses the selected folder during a change, the way a Remote
    /// refresh reveals that another session deleted it.
    struct Vanishing(Memory, bool);
    impl MailStore for Vanishing {
        fn folders(&self) -> Vec<String> {
            self.0.folders()
        }
        fn folder(&self, path: &str) -> Result<&Folder, Error> {
            if self.1 && path == "Work" {
                return Err(Error::Missing);
            }
            self.0.folder(path)
        }
        fn edit_folder(&mut self, path: &str, op: FolderOp<'_>) -> Result<(), Error> {
            self.0.edit_folder(path, op)
        }
        fn change(&mut self, path: &str, change: Change<'_>) -> Result<Applied, Error> {
            let r = self.0.change(path, change);
            self.1 = true;
            r
        }
    }

    /// A batched change that stops halfway: half of the UIDs commit, then Partial.
    struct Halfway(Memory);
    impl MailStore for Halfway {
        fn folders(&self) -> Vec<String> {
            self.0.folders()
        }
        fn folder(&self, path: &str) -> Result<&Folder, Error> {
            self.0.folder(path)
        }
        fn edit_folder(&mut self, path: &str, op: FolderOp<'_>) -> Result<(), Error> {
            self.0.edit_folder(path, op)
        }
        fn change(&mut self, path: &str, change: Change<'_>) -> Result<Applied, Error> {
            match change {
                Change::Flags(uids, mode, flags, since) => {
                    self.0.change(
                        path,
                        Change::Flags(&uids[..uids.len() / 2], mode, flags, since),
                    )?;
                    Err(Error::Partial)
                }
                Change::Transfer(uids, to, moving) => {
                    self.0
                        .change(path, Change::Transfer(&uids[..uids.len() / 2], to, moving))?;
                    Err(Error::Partial)
                }
                other => self.0.change(path, other),
            }
        }
    }

    /// A store that sends long responses on as they are built (MailStore::flush).
    struct Flushing(Memory, std::cell::RefCell<Vec<Vec<u8>>>);
    impl MailStore for Flushing {
        fn flush(&self, out: &mut Vec<u8>) -> Result<(), Error> {
            self.1.borrow_mut().push(std::mem::take(out));
            Ok(())
        }
        fn folders(&self) -> Vec<String> {
            self.0.folders()
        }
        fn folder(&self, path: &str) -> Result<&Folder, Error> {
            self.0.folder(path)
        }
        fn edit_folder(&mut self, path: &str, op: FolderOp<'_>) -> Result<(), Error> {
            self.0.edit_folder(path, op)
        }
        fn change(&mut self, path: &str, change: Change<'_>) -> Result<Applied, Error> {
            self.0.change(path, change)
        }
    }

    /// A FETCH goes to the store in pieces of whole messages once it holds 256 KiB, and the pieces and what is left
    /// are exactly the response a store that keeps it whole returns; no limit applies to the command as a whole.
    #[test]
    fn a_long_fetch_is_handed_on_a_message_at_a_time() {
        let account = Account::new("mbx_test".into(), vec![], "x".into(), true);
        let now = Date::default();
        let mut plain = Memory::default();
        let body = vec![b'x'; 200 << 10];
        for i in 0..5 {
            let raw = [format!("Subject: {i}\r\n\r\n").as_bytes(), &body].concat();
            plain
                .change(
                    "INBOX",
                    Change::Append {
                        raw: &raw,
                        date: now,
                        flags: Flags::new(),
                        source: crate::store::Origin::Client { now },
                    },
                )
                .unwrap();
        }
        let fetch = |store: &mut dyn MailStore| {
            let mut imap = Imap::new(true);
            imap.authenticated = true;
            imap.step(b"a EXAMINE INBOX\r\n", &account, store, now);
            imap.step(b"b FETCH 1:5 (UID BODY.PEEK[])\r\n", &account, store, now)
                .bytes
        };
        let whole = fetch(&mut plain);
        let mut streamed = Flushing(plain, Default::default());
        let rest = fetch(&mut streamed);
        let pieces = streamed.1.into_inner();
        assert_eq!(
            pieces.len(),
            2,
            "two pieces of two messages, then the fifth"
        );
        assert!(
            pieces
                .iter()
                .all(|p| p.starts_with(b"* ") && p.ends_with(b")\r\n"))
        );
        assert_eq!([pieces.concat(), rest.clone()].concat(), whole);
        let rest = String::from_utf8_lossy(&rest);
        assert!(
            rest.starts_with("* 5 FETCH") && rest.ends_with("b OK Completed\r\n"),
            "{}",
            &rest[rest.len() - 40..]
        );
    }

    /// Chunked mutations (gateway/tear, 1,000-UID batches): a STORE that stops partway
    /// reports the messages whose flags changed, then NO; a COPY reports the new messages
    /// (EXISTS), then NO without COPYUID.
    #[test]
    fn a_partial_batched_change_reports_what_committed_then_fails() {
        let account = Account::new("mbx_test".into(), vec![], "x".into(), true);
        let mut store = Halfway(Memory::default());
        let now = Date::default();
        for _ in 0..4 {
            store
                .0
                .change(
                    "INBOX",
                    Change::Append {
                        raw: b"Subject: x\r\n\r\nbody",
                        date: now,
                        flags: Flags::new(),
                        source: crate::store::Origin::Client { now },
                    },
                )
                .unwrap();
        }
        let mut imap = Imap::new(true);
        imap.authenticated = true;
        imap.step(b"a SELECT INBOX\r\n", &account, &mut store, now);
        let r = imap.step(
            b"b STORE 1:4 +FLAGS (\\Flagged)\r\n",
            &account,
            &mut store,
            now,
        );
        let text = String::from_utf8_lossy(&r.bytes);
        assert_eq!(text.matches("FETCH").count(), 2, "{text}");
        assert!(
            text.contains("* 1 FETCH") && text.contains("* 2 FETCH"),
            "{text}"
        );
        assert!(
            text.ends_with(
                "b NO [UNAVAILABLE] Interrupted after part of the command was applied\r\n"
            ),
            "{text}"
        );
        let r = imap.step(b"c COPY 1:4 INBOX\r\n", &account, &mut store, now);
        let text = String::from_utf8_lossy(&r.bytes);
        assert!(
            text.contains("* 6 EXISTS") && !text.contains("COPYUID"),
            "{text}"
        );
        assert!(
            text.ends_with(
                "c NO [UNAVAILABLE] Interrupted after part of the command was applied\r\n"
            ),
            "{text}"
        );
    }

    /// LIST reads `*` as any run and `%` as a run within one level. Writing each run of
    /// wildcards as its widest member and comparing the literal start first changes no answer.
    #[test]
    fn list_patterns_keep_the_plain_reading_of_both_wildcards() {
        fn plain(pat: &[u8], name: &[u8]) -> bool {
            let mut prev = vec![false; name.len() + 1];
            prev[0] = true;
            for &c in pat {
                let mut next = vec![false; prev.len()];
                next[0] = prev[0] && matches!(c, b'*' | b'%');
                for (i, &b) in name.iter().enumerate() {
                    next[i + 1] = match c {
                        b'*' => prev[i + 1] || next[i],
                        b'%' => prev[i + 1] || (b != b'/' && next[i]),
                        _ => prev[i] && c == b,
                    }
                }
                prev = next
            }
            prev[name.len()]
        }
        fn words(alphabet: &[u8], longest: usize) -> Vec<Vec<u8>> {
            let mut all = vec![vec![]];
            let mut from = 0;
            for _ in 0..longest {
                let until = all.len();
                for i in from..until {
                    for &c in alphabet {
                        let mut w = all[i].clone();
                        w.push(c);
                        all.push(w);
                    }
                }
                from = until;
            }
            all
        }
        let names = words(b"ab/", 5);
        for pat in words(b"a/*%", 5) {
            let short = widest(&pat);
            assert!(
                !short
                    .windows(2)
                    .any(|w| WILD.contains(&w[0]) && WILD.contains(&w[1]))
            );
            for name in &names {
                assert_eq!(
                    wildcard(&short, name),
                    plain(&pat, name),
                    "{:?} on {:?}",
                    String::from_utf8_lossy(&pat),
                    String::from_utf8_lossy(name)
                );
            }
        }
    }

    /// An inbox at its folder limits (200 folders, 255-byte names) lists for any pattern
    /// with work set by its folders: a run of wildcards is one wildcard, a literal pattern
    /// is a comparison, and a wildcard part too long for the listed names is refused before
    /// any folder is matched.
    #[test]
    fn list_work_follows_the_folders_not_the_length_of_the_pattern() {
        let account = Account::new("mbx_test".into(), vec![], "x".into(), true);
        let mut store = Memory::default();
        let now = Date::default();
        let deep = vec!["x".repeat(27); 7].join("/");
        let folder = |i: usize| format!("{deep}/{}{i:06}", "y".repeat(53));
        let existing = store.folders().len();
        for i in 0..200 - existing {
            assert_eq!(folder(i).len(), 255);
            store.edit_folder(&folder(i), FolderOp::Create).unwrap();
        }
        store
            .edit_folder(&folder(7), FolderOp::Subscribe(true))
            .unwrap();
        let listed: usize = store.folders().iter().map(|n| n.len() + 1).sum();
        let mut imap = Imap::new(true);
        imap.authenticated = true;
        let mut list = |command: String| {
            let r = imap.step(
                format!("a {command}\r\n").as_bytes(),
                &account,
                &mut store,
                now,
            );
            String::from_utf8_lossy(&r.bytes).into_owned()
        };
        let stars = "*".repeat(65_000);
        let mixed = "%*".repeat(32_500);
        assert_eq!(widest(format!("{stars}{stars}").as_bytes()), b"*");
        assert_eq!(widest(format!("a{mixed}b%%c").as_bytes()), b"a*b%c");
        for (command, lines) in [
            ("LIST \"\" \"*\"".to_string(), 200),
            (
                format!("LIST {{65000+}}\r\n{stars} {{65000+}}\r\n{stars}"),
                200,
            ),
            (format!("LIST \"\" {{65000+}}\r\n{mixed}"), 200),
            (format!("LIST \"\" \"{deep}/%\""), 200 - existing),
            (format!("LIST \"\" \"{}\"", folder(3)), 1),
            (format!("LIST \"{deep}/\" \"%000003\""), 1),
            (format!("LIST \"\" \"{}%\"", "x".repeat(27)), 0),
            (format!("LIST \"\" {{65000+}}\r\n{}", "x".repeat(65_000)), 0),
            (format!("LSUB \"\" {{65000+}}\r\n{mixed}"), existing + 1),
        ] {
            let text = list(command.clone());
            let shown = &command[..command.len().min(40)];
            assert!(text.ends_with("a OK Completed\r\n"), "{shown}: {text}");
            assert_eq!(text.matches("\r\n").count() - 1, lines, "{shown}");
        }
        let fits = LIST_WORK / listed;
        let text = list(format!("LIST \"\" \"%{}\"", "y".repeat(fits - 1)));
        assert_eq!(text, "a OK Completed\r\n");
        for command in ["LIST", "LSUB"] {
            let text = list(format!("{command} \"\" \"%{}\"", "y".repeat(fits)));
            assert_eq!(text, "a NO [LIMIT] Inbox limit exceeded\r\n");
        }
        let text = list(format!(
            "LIST \"\" \"{}%{}\"",
            "x".repeat(fits),
            "y".repeat(8)
        ));
        assert_eq!(text, "a OK Completed\r\n");
    }

    /// A header index that finds UIDs 2 and 6 for any term, so SEARCH takes its indexed paths.
    struct Indexed(Memory);
    impl MailStore for Indexed {
        fn folders(&self) -> Vec<String> {
            self.0.folders()
        }
        fn folder(&self, path: &str) -> Result<&Folder, Error> {
            self.0.folder(path)
        }
        fn edit_folder(&mut self, path: &str, op: FolderOp<'_>) -> Result<(), Error> {
            self.0.edit_folder(path, op)
        }
        fn change(&mut self, path: &str, change: Change<'_>) -> Result<Applied, Error> {
            self.0.change(path, change)
        }
        fn indexed(&self, _: &str, _: search::Field, _: &str) -> Result<Option<Vec<u32>>, Error> {
            Ok(Some(vec![2, 6]))
        }
    }

    /// RFC 4731: SEARCH and UID SEARCH with RETURN answer one ESEARCH line with what was asked, on the indexed,
    /// planned and scanning paths. No match leaves only COUNT 0; plain SEARCH still answers * SEARCH.
    #[test]
    fn search_return_answers_one_esearch_line() {
        let account = Account::new("mbx_test".into(), vec![], "x".into(), true);
        let mut store = Indexed(Memory::default());
        let now = Date::default();
        for _ in 0..6 {
            store
                .0
                .change(
                    "INBOX",
                    Change::Append {
                        raw: b"Subject: x\r\n\r\nbody",
                        date: now,
                        flags: Flags::new(),
                        source: crate::store::Origin::Client { now },
                    },
                )
                .unwrap();
        }
        let mut imap = Imap::new(true);
        imap.authenticated = true;
        let mut step = |command: &str| {
            let r = imap.step(
                format!("{command}\r\n").as_bytes(),
                &account,
                &mut store,
                now,
            );
            String::from_utf8(r.bytes).unwrap()
        };
        assert!(step("a CAPABILITY").contains(" ESEARCH LIST-STATUS "));
        step("a SELECT INBOX");
        step("a STORE 3 +FLAGS (\\Deleted)");
        step("a EXPUNGE");
        // UIDs 1, 2, 4, 5 and 6 at 1 to 5; UIDs 2 and 5 (2 and 4) seen.
        step("a STORE 2,4 +FLAGS (\\Seen)");
        for (command, answer) in [
            (
                "SEARCH RETURN (MIN MAX COUNT ALL) ALL",
                "* ESEARCH (TAG \"b\") MIN 1 MAX 5 COUNT 5 ALL 1:5",
            ),
            (
                "UID SEARCH RETURN (MIN MAX COUNT ALL) ALL",
                "* ESEARCH (TAG \"b\") UID MIN 1 MAX 6 COUNT 5 ALL 1:2,4:6",
            ),
            (
                "UID SEARCH RETURN () SEEN",
                "* ESEARCH (TAG \"b\") UID ALL 2,5",
            ),
            (
                "search return (count min) seen",
                "* ESEARCH (TAG \"b\") MIN 2 COUNT 2",
            ),
            (
                "SEARCH RETURN (MIN MAX COUNT ALL) DELETED",
                "* ESEARCH (TAG \"b\") COUNT 0",
            ),
            (
                "UID SEARCH RETURN (MIN MAX ALL) DELETED",
                "* ESEARCH (TAG \"b\") UID",
            ),
            (
                "SEARCH RETURN (ALL COUNT) SUBJECT x",
                "* ESEARCH (TAG \"b\") COUNT 2 ALL 2,5",
            ),
            (
                "UID SEARCH RETURN (MIN MAX) SUBJECT x SEEN",
                "* ESEARCH (TAG \"b\") UID MIN 2 MAX 2",
            ),
            ("SEARCH SEEN", "* SEARCH 2 4"),
            ("UID SEARCH SEEN", "* SEARCH 2 5"),
            ("SEARCH SUBJECT x", "* SEARCH 2 5"),
        ] {
            assert_eq!(
                step(&format!("b {command}")),
                format!("{answer}\r\nb OK Completed\r\n"),
                "{command}"
            );
        }
        for command in ["SEARCH RETURN (SAVE) ALL", "SEARCH RETURN (MIN)"] {
            assert_eq!(
                step(&format!("b {command}")),
                "b BAD Invalid command\r\n",
                "{command}"
            );
        }
    }

    /// RFC 5819: RETURN (STATUS (...)) follows each selectable mailbox's LIST line with its STATUS line, alone or
    /// with SPECIAL-USE in either order, and RETURN (SPECIAL-USE) is a plain LIST.
    #[test]
    fn list_return_status_follows_each_selectable_mailbox() {
        let account = Account::new("mbx_test".into(), vec![], "x".into(), true);
        let mut store = Memory::default();
        let now = Date::default();
        store.edit_folder("Work", FolderOp::Create).unwrap();
        for flags in [Flags::new(), Flags::from(["\\Seen".into()])] {
            store
                .change(
                    "INBOX",
                    Change::Append {
                        raw: b"Subject: x\r\n\r\nbody",
                        date: now,
                        flags,
                        source: crate::store::Origin::Client { now },
                    },
                )
                .unwrap();
        }
        let validity = store.folder("INBOX").unwrap().validity;
        let mut imap = Imap::new(true);
        imap.authenticated = true;
        let mut step = |command: &str| {
            let r = imap.step(
                format!("a {command}\r\n").as_bytes(),
                &account,
                &mut store,
                now,
            );
            String::from_utf8(r.bytes).unwrap()
        };
        let plain = step("LIST \"\" \"*\"");
        let lists: Vec<_> = plain.lines().filter(|l| l.starts_with("* LIST")).collect();
        assert_eq!(lists.len(), 7, "{plain}");
        let text = step("LIST \"\" \"*\" RETURN (STATUS (MESSAGES UNSEEN UIDNEXT UIDVALIDITY))");
        let lines: Vec<_> = text.lines().collect();
        assert_eq!(lines.len(), 2 * lists.len() + 1, "{text}");
        for (i, list) in lists.iter().enumerate() {
            assert_eq!(lines[2 * i], *list);
            let name = list.rsplit(' ').next().unwrap();
            assert!(
                lines[2 * i + 1].starts_with(&format!("* STATUS {name} (MESSAGES ")),
                "{text}"
            );
        }
        assert!(text.contains(&format!(
            "* LIST () \"/\" \"INBOX\"\r\n* STATUS \"INBOX\" (MESSAGES 2 UNSEEN 1 UIDNEXT 3 UIDVALIDITY {validity})\r\n"
        )));
        assert!(text.ends_with("a OK Completed\r\n"));
        let both = step("LIST \"\" \"*\" RETURN (SPECIAL-USE STATUS (MESSAGES))");
        assert_eq!(
            both,
            step("LIST \"\" \"*\" return (status (messages) special-use)")
        );
        assert_eq!(both.matches("* STATUS").count(), lists.len());
        assert!(
            both.contains("* LIST (\\Sent) \"/\" \"Sent\"\r\n* STATUS \"Sent\" (MESSAGES 0)\r\n")
        );
        assert_eq!(step("LIST \"\" \"*\" RETURN (SPECIAL-USE)"), plain);
        assert_eq!(step("LIST \"\" \"*\" RETURN ()"), plain);
        // An extended LIST matches nothing with an empty pattern (RFC 5258 3).
        assert_eq!(
            step("LIST \"\" \"\" RETURN (STATUS (MESSAGES))"),
            "a OK Completed\r\n"
        );
        for bad in [
            "RETURN (STATUS (BOGUS))",
            "RETURN (STATUS (MESSAGES) BOGUS)",
            "RETURN (SPECIAL-USE )",
        ] {
            assert_eq!(
                step(&format!("LIST \"\" \"*\" {bad}")),
                "a BAD Invalid command\r\n",
                "{bad}"
            );
        }
    }

    /// RFC 5161 and RFC 7162 3.2.3: ENABLED lists what each command turned on, and QRESYNC implies CONDSTORE.
    #[test]
    fn enable_lists_what_it_turned_on() {
        let account = Account::new("mbx_test".into(), vec![], "x".into(), true);
        let mut store = Memory::default();
        let now = Date::default();
        let mut step = |imap: &mut Imap, command: &str| {
            let r = imap.step(
                format!("{command}\r\n").as_bytes(),
                &account,
                &mut store,
                now,
            );
            String::from_utf8(r.bytes).unwrap()
        };
        let mut one = Imap::new(true);
        one.authenticated = true;
        assert!(step(&mut one, "a CAPABILITY").contains(" CONDSTORE QRESYNC "));
        for (command, enabled) in [
            ("ENABLE CONDSTORE", "* ENABLED CONDSTORE"),
            ("ENABLE condstore QRESYNC X-NONE", "* ENABLED QRESYNC"),
            ("ENABLE QRESYNC", "* ENABLED"),
        ] {
            assert_eq!(
                step(&mut one, &format!("a {command}")),
                format!("{enabled}\r\na OK Completed\r\n")
            );
        }
        let mut two = Imap::new(true);
        two.authenticated = true;
        assert_eq!(
            step(&mut two, "a ENABLE QRESYNC"),
            "* ENABLED QRESYNC\r\na OK Completed\r\n"
        );
        assert!(step(&mut two, "b SELECT INBOX").contains("* OK [HIGHESTMODSEQ 1] Highest\r\n"));
    }

    /// RFC 7162 3.1: the first CONDSTORE enabling command answers HIGHESTMODSEQ, then SELECT does; FETCH MODSEQ and
    /// CHANGEDSINCE, STORE UNCHANGEDSINCE with MODIFIED, SEARCH MODSEQ (with the ESEARCH MIN/MAX rule of 3.1.10),
    /// STATUS HIGHESTMODSEQ, and unsolicited FETCHes that carry MODSEQ.
    #[test]
    fn condstore_reports_and_conditions_on_modseq() {
        let account = Account::new("mbx_test".into(), vec![], "x".into(), true);
        let mut store = Memory::default();
        let now = Date::default();
        // UIDs 1 to 4 at MODSEQ 2 to 5.
        for _ in 0..4 {
            store
                .change(
                    "INBOX",
                    Change::Append {
                        raw: b"Subject: x\r\n\r\nbody",
                        date: now,
                        flags: Flags::new(),
                        source: crate::store::Origin::Client { now },
                    },
                )
                .unwrap();
        }
        let mut step = |imap: &mut Imap, command: &str| {
            let r = imap.step(
                format!("{command}\r\n").as_bytes(),
                &account,
                &mut store,
                now,
            );
            String::from_utf8(r.bytes).unwrap()
        };
        let mut one = Imap::new(true);
        one.authenticated = true;
        assert!(!step(&mut one, "a SELECT INBOX").contains("HIGHESTMODSEQ"));
        for command in [
            "b FETCH 1 (MODSEQ)",
            "c SELECT INBOX",
            "d STORE 2 +FLAGS (\\Seen)",
            "e FETCH 1:* (FLAGS) (CHANGEDSINCE 5)",
            "f STORE 1:3 (UNCHANGEDSINCE 5) +FLAGS.SILENT (\\Flagged)",
            "g UID STORE 1:4 (UNCHANGEDSINCE 6) -FLAGS (\\Flagged)",
        ] {
            let text = step(&mut one, command);
            let expected = match &command[..1] {
                "b" => {
                    "* OK [HIGHESTMODSEQ 5] Highest\r\n* 1 FETCH (MODSEQ (2))\r\nb OK Completed\r\n"
                }
                "c" => {
                    assert!(
                        text.contains("* OK [HIGHESTMODSEQ 5] Highest\r\n"),
                        "{text}"
                    );
                    // RFC 7162 3.2.11: CLOSED on every implicit close, QRESYNC or not.
                    assert!(text.starts_with("* OK [CLOSED] Previous mailbox closed\r\n"));
                    continue;
                }
                "d" => "* 2 FETCH (UID 2 FLAGS (\\Seen) MODSEQ (6))\r\nd OK Completed\r\n",
                "e" => "* 2 FETCH (FLAGS (\\Seen) MODSEQ (6))\r\ne OK Completed\r\n",
                // UID 2 changed after 5: MODIFIED. The rest is .SILENT, which still answers MODSEQ.
                "f" => {
                    "* 1 FETCH (UID 1 MODSEQ (7))\r\n* 3 FETCH (UID 3 MODSEQ (7))\r\nf OK [MODIFIED 2] Completed\r\n"
                }
                _ => {
                    "* 2 FETCH (UID 2 FLAGS (\\Seen) MODSEQ (8))\r\n* 4 FETCH (UID 4 FLAGS () MODSEQ (8))\r\ng OK [MODIFIED 1,3] Completed\r\n"
                }
            };
            assert_eq!(text, expected, "{command}");
        }
        assert_eq!(
            step(&mut one, "b FETCH 1 (MODSEQ)"),
            "* 1 FETCH (MODSEQ (7))\r\nb OK Completed\r\n"
        );
        // MODSEQ now: UIDs 1 and 3 at 7, 2 and 4 at 8.
        for (command, answer) in [
            ("SEARCH MODSEQ 8", "* SEARCH 2 4 (MODSEQ 8)"),
            ("SEARCH MODSEQ 9", "* SEARCH"),
            (
                "SEARCH MODSEQ \"/flags/\\\\seen\" all 7 UNSEEN",
                "* SEARCH 1 3 4 (MODSEQ 8)",
            ),
            (
                "UID SEARCH RETURN (MIN) MODSEQ 7",
                "* ESEARCH (TAG \"h\") UID MIN 1 MODSEQ 7",
            ),
            (
                "SEARCH RETURN (MIN MAX) 1:3 MODSEQ 7",
                "* ESEARCH (TAG \"h\") MIN 1 MAX 3 MODSEQ 7",
            ),
            (
                "SEARCH RETURN (ALL) MODSEQ 7",
                "* ESEARCH (TAG \"h\") ALL 1:4 MODSEQ 8",
            ),
            (
                "SEARCH RETURN (COUNT) MODSEQ 9",
                "* ESEARCH (TAG \"h\") COUNT 0",
            ),
            (
                "STATUS INBOX (HIGHESTMODSEQ MESSAGES)",
                "* STATUS \"INBOX\" (HIGHESTMODSEQ 8 MESSAGES 4)",
            ),
        ] {
            assert_eq!(
                step(&mut one, &format!("h {command}")),
                format!("{answer}\r\nh OK Completed\r\n"),
                "{command}"
            );
        }
        let mut two = Imap::new(true);
        two.authenticated = true;
        step(&mut two, "x SELECT INBOX");
        step(&mut two, "x STORE 3 -FLAGS (\\Flagged)");
        // The .SILENT STORE left 1 and 3 to the next update, which now carries their MODSEQ.
        assert_eq!(
            step(&mut one, "i NOOP"),
            "* 1 FETCH (UID 1 FLAGS (\\Flagged) MODSEQ (7))\r\n* 3 FETCH (UID 3 FLAGS () MODSEQ (9))\r\ni OK Completed\r\n"
        );
    }

    /// RFC 7162 3.2.5 and 3.2.6: SELECT (QRESYNC ...) answers VANISHED (EARLIER) from the store's tombstones and the
    /// changed messages' FETCHes, within known UIDs; a different UIDVALIDITY is a plain SELECT; UID FETCH VANISHED
    /// answers the same. A store that can't tell names every known UID the mailbox doesn't hold.
    #[test]
    fn qresync_select_reports_what_vanished_and_changed() {
        let account = Account::new("mbx_test".into(), vec![], "x".into(), true);
        let now = Date::default();
        // UIDs 1 to 6 at MODSEQ 2 to 7; 2 and 4 expunged at 9; 5 seen at 10.
        let inbox = || {
            let mut m = Memory::default();
            for _ in 0..6 {
                m.change(
                    "INBOX",
                    Change::Append {
                        raw: b"Subject: x\r\n\r\nbody",
                        date: now,
                        flags: Flags::new(),
                        source: crate::store::Origin::Client { now },
                    },
                )
                .unwrap();
            }
            let deleted = Flags::from(["\\Deleted".into()]);
            m.change("INBOX", Change::Flags(&[2, 4], Mode::Add, deleted, None))
                .unwrap();
            m.change("INBOX", Change::Expunge(None)).unwrap();
            let seen = Flags::from(["\\Seen".into()]);
            m.change("INBOX", Change::Flags(&[5], Mode::Add, seen, None))
                .unwrap();
            m
        };
        let mut store = inbox();
        let mut fallback = Indexed(inbox());
        assert_eq!(store.vanished("INBOX", 7).unwrap(), Some(vec![2, 4]));
        assert_eq!(store.vanished("INBOX", 9).unwrap(), Some(vec![]));
        let changed = "* 3 FETCH (UID 5 FLAGS (\\Seen) MODSEQ (10))\r\n";
        let tail = |code: &str| format!("* FLAGS ({FLAGS})\r\n{code}");
        let mut imap = Imap::new(true);
        imap.authenticated = true;
        let mut step = |command: &str| {
            let r = imap.step(
                format!("{command}\r\n").as_bytes(),
                &account,
                &mut store,
                now,
            );
            String::from_utf8(r.bytes).unwrap()
        };
        assert_eq!(
            step("a SELECT INBOX (QRESYNC (1 7))"),
            "a BAD Not permitted in this state or unsupported\r\n"
        );
        step("a ENABLE QRESYNC");
        let text = step("b SELECT INBOX (QRESYNC (1 7))");
        assert!(
            text.contains("* OK [HIGHESTMODSEQ 10] Highest\r\n"),
            "{text}"
        );
        assert!(
            text.ends_with(&tail(&format!(
                "* VANISHED (EARLIER) 2,4\r\n{changed}b OK [READ-WRITE] Completed\r\n"
            ))),
            "{text}"
        );
        let text = step("c EXAMINE INBOX (QRESYNC (1 7 1:3))");
        assert!(
            text.starts_with("* OK [CLOSED] Previous mailbox closed\r\n"),
            "{text}"
        );
        assert!(
            text.ends_with(&tail(
                "* VANISHED (EARLIER) 2\r\nc OK [READ-ONLY] Completed\r\n"
            )),
            "{text}"
        );
        let text = step("d SELECT INBOX (QRESYNC (99 7))");
        assert!(
            text.ends_with(&tail("d OK [READ-WRITE] Completed\r\n")),
            "{text}"
        );
        assert_eq!(
            step("e UID FETCH 1:* (FLAGS) (CHANGEDSINCE 7 VANISHED)"),
            "* VANISHED (EARLIER) 2,4\r\n* 3 FETCH (FLAGS (\\Seen) UID 5 MODSEQ (10))\r\ne OK Completed\r\n"
        );
        for command in [
            "f FETCH 1:* (FLAGS) (CHANGEDSINCE 7 VANISHED)",
            "f UID FETCH 1:* (FLAGS) (VANISHED)",
        ] {
            assert_eq!(
                step(command),
                "f BAD Not permitted in this state or unsupported\r\n"
            );
        }
        let mut imap = Imap::new(true);
        imap.authenticated = true;
        let mut step = |command: &str| {
            let r = imap.step(
                format!("{command}\r\n").as_bytes(),
                &account,
                &mut fallback,
                now,
            );
            String::from_utf8(r.bytes).unwrap()
        };
        step("a ENABLE QRESYNC");
        assert!(
            step("b SELECT INBOX (QRESYNC (1 7))").ends_with(&tail(&format!(
                "* VANISHED (EARLIER) 2,4\r\n{changed}b OK [READ-WRITE] Completed\r\n"
            )))
        );
        assert!(
            step("c SELECT INBOX (QRESYNC (1 7 1:3,9))").ends_with(&tail(
                "* VANISHED (EARLIER) 2\r\nc OK [READ-WRITE] Completed\r\n"
            ))
        );
    }

    /// RFC 7162 3.2.7 and 3.2.10: once QRESYNC is on, expunges, this session's and another's, are VANISHED, ahead
    /// of the FETCHes renumbered after them, and EXPUNGE answers the new HIGHESTMODSEQ. Other sessions keep EXPUNGE.
    #[test]
    fn qresync_reports_vanished_instead_of_expunge() {
        let account = Account::new("mbx_test".into(), vec![], "x".into(), true);
        let mut store = Memory::default();
        let now = Date::default();
        // UIDs 1 to 4 at MODSEQ 2 to 5.
        for _ in 0..4 {
            store
                .change(
                    "INBOX",
                    Change::Append {
                        raw: b"Subject: x\r\n\r\nbody",
                        date: now,
                        flags: Flags::new(),
                        source: crate::store::Origin::Client { now },
                    },
                )
                .unwrap();
        }
        let mut step = |imap: &mut Imap, command: &str| {
            let r = imap.step(
                format!("{command}\r\n").as_bytes(),
                &account,
                &mut store,
                now,
            );
            String::from_utf8(r.bytes).unwrap()
        };
        let (mut one, mut two) = (Imap::new(true), Imap::new(true));
        one.authenticated = true;
        two.authenticated = true;
        step(&mut one, "a ENABLE QRESYNC");
        step(&mut one, "a SELECT INBOX");
        step(&mut two, "a SELECT INBOX");
        assert_eq!(
            step(&mut one, "b STORE 2,3 +FLAGS.SILENT (\\Deleted)"),
            "* 2 FETCH (UID 2 MODSEQ (6))\r\n* 3 FETCH (UID 3 MODSEQ (6))\r\nb OK Completed\r\n"
        );
        assert_eq!(
            step(&mut one, "c EXPUNGE"),
            "* VANISHED 2:3\r\nc OK [HIGHESTMODSEQ 7] Completed\r\n"
        );
        assert_eq!(
            step(&mut two, "d NOOP"),
            "* 2 EXPUNGE\r\n* 2 EXPUNGE\r\nd OK Completed\r\n"
        );
        step(&mut two, "e UID STORE 4 +FLAGS (\\Flagged)");
        step(&mut two, "e STORE 1 +FLAGS (\\Deleted)");
        assert_eq!(
            step(&mut two, "e EXPUNGE"),
            "* 1 EXPUNGE\r\ne OK Completed\r\n"
        );
        assert_eq!(
            step(&mut one, "f NOOP"),
            "* VANISHED 1\r\n* 1 FETCH (UID 4 FLAGS (\\Flagged) MODSEQ (8))\r\nf OK Completed\r\n"
        );
        // MOVE answers its HIGHESTMODSEQ as EXPUNGE does.
        assert_eq!(
            step(&mut one, "h MOVE 1 Archive"),
            "* OK [COPYUID 4 4 1] Moved\r\n* VANISHED 4\r\nh OK [HIGHESTMODSEQ 11] Completed\r\n"
        );
        assert!(
            step(&mut one, "g SELECT Archive")
                .starts_with("* OK [CLOSED] Previous mailbox closed\r\n")
        );
    }

    /// RFC 5258: selection options SUBSCRIBED (with RECURSIVEMATCH's CHILDINFO, also on a parent that doesn't exist)
    /// and REMOTE, return options SUBSCRIBED and CHILDREN, several patterns (a literal among them, and an empty one that
    /// matches nothing), and BAD for RECURSIVEMATCH alone or an unknown option. A plain LIST is unchanged.
    #[test]
    fn list_extended_selects_and_returns() {
        let account = Account::new("mbx_test".into(), vec![], "x".into(), true);
        let mut store = Memory::default();
        let now = Date::default();
        for (name, subscribed) in [
            ("Work", false),
            ("Work/A", true),
            ("Work/B", false),
            ("Proj/X", true),
        ] {
            store.edit_folder(name, FolderOp::Create).unwrap();
            if subscribed {
                store.edit_folder(name, FolderOp::Subscribe(true)).unwrap();
            }
        }
        let mut imap = Imap::new(true);
        imap.authenticated = true;
        let mut step = |command: &str| {
            let r = imap.step(
                format!("a {command}\r\n").as_bytes(),
                &account,
                &mut store,
                now,
            );
            String::from_utf8(r.bytes).unwrap()
        };
        let lists = |text: String| {
            assert!(text.ends_with("a OK Completed\r\n"), "{text}");
            text.lines()
                .filter(|l| l.starts_with("* LIST"))
                .map(str::to_owned)
                .collect::<Vec<_>>()
        };
        let plain = lists(step("LIST \"\" \"*\""));
        assert_eq!(plain.len(), 10);
        assert!(plain.contains(&"* LIST () \"/\" \"Work/A\"".to_owned()));
        assert_eq!(
            lists(step("LIST (SUBSCRIBED) \"\" \"*\"")),
            [
                "* LIST (\\Archive \\Subscribed) \"/\" \"Archive\"",
                "* LIST (\\Drafts \\Subscribed) \"/\" \"Drafts\"",
                "* LIST (\\Subscribed) \"/\" \"INBOX\"",
                "* LIST (\\Junk \\Subscribed) \"/\" \"Junk\"",
                "* LIST (\\Subscribed) \"/\" \"Proj/X\"",
                "* LIST (\\Sent \\Subscribed) \"/\" \"Sent\"",
                "* LIST (\\Trash \\Subscribed) \"/\" \"Trash\"",
                "* LIST (\\Subscribed) \"/\" \"Work/A\"",
            ]
        );
        assert_eq!(
            lists(step("LIST (SUBSCRIBED RECURSIVEMATCH) \"\" \"%\"")),
            [
                "* LIST (\\Archive \\Subscribed) \"/\" \"Archive\"",
                "* LIST (\\Drafts \\Subscribed) \"/\" \"Drafts\"",
                "* LIST (\\Subscribed) \"/\" \"INBOX\"",
                "* LIST (\\Junk \\Subscribed) \"/\" \"Junk\"",
                "* LIST (\\NonExistent) \"/\" \"Proj\" (\"CHILDINFO\" (\"SUBSCRIBED\"))",
                "* LIST (\\Sent \\Subscribed) \"/\" \"Sent\"",
                "* LIST (\\Trash \\Subscribed) \"/\" \"Trash\"",
                "* LIST () \"/\" \"Work\" (\"CHILDINFO\" (\"SUBSCRIBED\"))",
            ]
        );
        assert_eq!(
            lists(step(
                "LIST (REMOTE) \"\" (\"INBOX\" {6}\r\nWork/% \"\") RETURN (CHILDREN SUBSCRIBED)"
            )),
            [
                "* LIST (\\Subscribed \\HasNoChildren) \"/\" \"INBOX\"",
                "* LIST (\\Subscribed \\HasNoChildren) \"/\" \"Work/A\"",
                "* LIST (\\HasNoChildren) \"/\" \"Work/B\"",
            ]
        );
        assert_eq!(
            lists(step("LIST \"\" Work RETURN (CHILDREN)")),
            ["* LIST (\\HasChildren) \"/\" \"Work\""]
        );
        assert!(lists(step("LIST () \"\" \"\"")).is_empty());
        for bad in [
            "LIST (RECURSIVEMATCH) \"\" \"*\"",
            "LIST (REMOTE RECURSIVEMATCH) \"\" \"*\"",
            "LIST (BOGUS) \"\" \"*\"",
            "LIST \"\" \"*\" RETURN (BOGUS)",
            "LIST \"\" () RETURN (CHILDREN)",
        ] {
            assert_eq!(step(bad), "a BAD Invalid command\r\n", "{bad}");
        }
        assert_eq!(lists(step("LIST \"\" \"*\"")), plain);
    }

    /// RFC 9208: one quota root for the inbox, here the memory store's own bound; GETQUOTA of another root and
    /// SETQUOTA answer NO; STATUS DELETED and DELETED-STORAGE count \Deleted messages. A store that can't tell has no
    /// quota root.
    #[test]
    fn quota_answers_one_root_for_the_inbox() {
        let account = Account::new("mbx_test".into(), vec![], "x".into(), true);
        let now = Date::default();
        let mut store = Memory::default();
        store
            .change(
                "INBOX",
                Change::Append {
                    raw: &[b'x'; 3000],
                    date: now,
                    flags: Flags::new(),
                    source: crate::store::Origin::Client { now },
                },
            )
            .unwrap();
        let mut unknown = Indexed(Memory::default());
        let mut imap = Imap::new(true);
        imap.authenticated = true;
        let mut step = |store: &mut dyn MailStore, command: &str| {
            let r = imap.step(format!("a {command}\r\n").as_bytes(), &account, store, now);
            String::from_utf8(r.bytes).unwrap()
        };
        let quota = "* QUOTA \"\" (STORAGE 3 131072)\r\n";
        for (command, answer) in [
            (
                "GETQUOTAROOT INBOX",
                format!("* QUOTAROOT \"INBOX\" \"\"\r\n{quota}a OK Completed\r\n"),
            ),
            ("GETQUOTA \"\"", format!("{quota}a OK Completed\r\n")),
            (
                "GETQUOTA \"other\"",
                "a NO [NONEXISTENT] No such quota root\r\n".into(),
            ),
            (
                "SETQUOTA \"\" (STORAGE 10)",
                "a NO [CANNOT] Quotas can't be changed here\r\n".into(),
            ),
        ] {
            assert_eq!(step(&mut store, command), answer, "{command}");
        }
        step(&mut store, "SELECT INBOX");
        step(&mut store, "STORE 1 +FLAGS (\\Deleted)");
        assert_eq!(
            step(
                &mut store,
                "STATUS INBOX (MESSAGES DELETED DELETED-STORAGE)"
            ),
            "* STATUS \"INBOX\" (MESSAGES 1 DELETED 1 DELETED-STORAGE 3)\r\na OK Completed\r\n"
        );
        let mut imap = Imap::new(true);
        imap.authenticated = true;
        let mut step = |command: &str| {
            let r = imap.step(
                format!("a {command}\r\n").as_bytes(),
                &account,
                &mut unknown,
                now,
            );
            String::from_utf8(r.bytes).unwrap()
        };
        assert_eq!(
            step("GETQUOTAROOT INBOX"),
            "* QUOTAROOT \"INBOX\"\r\na OK Completed\r\n"
        );
        assert_eq!(
            step("GETQUOTA \"\""),
            "a NO [NONEXISTENT] No such quota root\r\n"
        );
    }

    /// A store that changes UID 1 just before a conditional flag change, as another session can between the core's
    /// check of its snapshot and the change.
    struct Racing(Memory);
    impl MailStore for Racing {
        fn folders(&self) -> Vec<String> {
            self.0.folders()
        }
        fn folder(&self, path: &str) -> Result<&Folder, Error> {
            self.0.folder(path)
        }
        fn edit_folder(&mut self, path: &str, op: FolderOp<'_>) -> Result<(), Error> {
            self.0.edit_folder(path, op)
        }
        fn change(&mut self, path: &str, change: Change<'_>) -> Result<Applied, Error> {
            if let Change::Flags(_, _, _, Some(_)) = &change {
                let other = Flags::from(["$Other".into()]);
                self.0
                    .change(path, Change::Flags(&[1], Mode::Add, other, None))?;
            }
            self.0.change(path, change)
        }
    }

    /// RFC 7162 3.1.3: the store checks UNCHANGEDSINCE again as it applies the change, so a message changed in between
    /// is MODIFIED and not answered as stored.
    #[test]
    fn unchanged_since_takes_the_stores_answer_too() {
        let account = Account::new("mbx_test".into(), vec![], "x".into(), true);
        let now = Date::default();
        // UIDs 1 and 2 at MODSEQ 2 and 3.
        let mut store = Racing(Memory::default());
        for _ in 0..2 {
            store
                .0
                .change(
                    "INBOX",
                    Change::Append {
                        raw: b"Subject: x\r\n\r\nbody",
                        date: now,
                        flags: Flags::new(),
                        source: crate::store::Origin::Client { now },
                    },
                )
                .unwrap();
        }
        let mut imap = Imap::new(true);
        imap.authenticated = true;
        imap.step(b"a SELECT INBOX\r\n", &account, &mut store, now);
        let r = imap.step(
            b"b STORE 1:2 (UNCHANGEDSINCE 3) +FLAGS (\\Seen)\r\n",
            &account,
            &mut store,
            now,
        );
        let text = String::from_utf8(r.bytes).unwrap();
        assert!(
            text.ends_with(
                "* 2 FETCH (UID 2 FLAGS (\\Seen) MODSEQ (5))\r\nb OK [MODIFIED 1] Completed\r\n"
            ),
            "{text}"
        );
        assert!(!text.contains("* 1 FETCH"), "{text}");
    }

    /// A SELECT (QRESYNC ...) that reports many changed messages goes to the store in pieces as a long FETCH does,
    /// and the pieces and the rest are the whole response.
    #[test]
    fn a_long_qresync_select_is_handed_on_as_it_is_built() {
        let account = Account::new("mbx_test".into(), vec![], "x".into(), true);
        let now = Date::default();
        let mut plain = Memory::default();
        let flags = Flags::from(["$a-keyword-long-enough-to-fill-a-response-quickly".into()]);
        for _ in 0..4000 {
            plain
                .change(
                    "INBOX",
                    Change::Append {
                        raw: b"Subject: x\r\n\r\nbody",
                        date: now,
                        flags: flags.clone(),
                        source: crate::store::Origin::Client { now },
                    },
                )
                .unwrap();
        }
        let select = |store: &mut dyn MailStore| {
            let mut imap = Imap::new(true);
            imap.authenticated = true;
            imap.step(b"a ENABLE QRESYNC\r\n", &account, store, now);
            imap.step(b"b SELECT INBOX (QRESYNC (1 1))\r\n", &account, store, now)
                .bytes
        };
        let whole = select(&mut plain);
        let mut streamed = Flushing(plain, Default::default());
        let rest = select(&mut streamed);
        let pieces = streamed.1.into_inner();
        assert!(!pieces.is_empty());
        assert!(rest.ends_with(b"b OK [READ-WRITE] Completed\r\n"));
        assert_eq!([pieces.concat(), rest].concat(), whole);
    }

    /// Found by gateway/tear on the Remote store (witness: B create Work, A select Work,
    /// B delete Work, A copy 1 Archive): the COPY's update said BYE, then the command sent a
    /// tagged OK and the connection stayed open.
    #[test]
    fn bye_found_during_a_command_follows_its_completion_and_closes() {
        let account = Account::new("mbx_test".into(), vec![], "x".into(), true);
        let mut store = Vanishing(Memory::default(), false);
        store.0.edit_folder("Work", FolderOp::Create).unwrap();
        let now = Date::default();
        for cmd in ["COPY 1 INBOX", "MOVE 1 INBOX", "EXPUNGE", "UID EXPUNGE 1:*"] {
            store.1 = false;
            let mut imap = Imap::new(true);
            imap.authenticated = true;
            assert!(
                imap.step(b"a SELECT Work\r\n", &account, &mut store, now)
                    .bytes
                    .ends_with(b"a OK [READ-WRITE] Completed\r\n")
            );
            let r = imap.step(format!("b {cmd}\r\n").as_bytes(), &account, &mut store, now);
            let text = String::from_utf8_lossy(&r.bytes);
            let ok = text.find("b OK").unwrap_or(usize::MAX);
            let bye = text.find("* BYE").unwrap_or(0);
            assert!(ok < bye, "{cmd}: {text}");
            assert!(
                text.ends_with("Selected mailbox no longer exists\r\n"),
                "{cmd}: {text}"
            );
            assert!(r.action == Action::Close, "{cmd}");
        }
    }
}
