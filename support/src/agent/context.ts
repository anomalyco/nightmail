// The per-conversation context the harness gives the agent (never taken from the conversation itself): <customer> says
// who is verified and what the agent may act on. Account facts come from the tools, when a question needs them.

export type Customer = {
  channel: 'chat' | 'email'; userId: string | null; name: string | null; email: string | null; role: string | null;
  workspace: { id: string; name: string } | null; workspaces: { id: string; name: string; role: string }[];
  verified: 'handoff' | 'dmarc' | 'signin' | 'magic_link' | null; contentAccess: boolean; page: string | null;
};

const esc = (s: unknown) => String(s ?? '').replace(/[<>]/g, '').slice(0, 200);
export const firstName = (name: string | null | undefined) => (name ?? '').trim().split(/\s+/)[0]?.slice(0, 40) || null;

export function customerBlock(c: Customer) {
  const lines = [
    `channel: ${c.channel}`,
    `verified: ${c.verified ?? 'no — answer general questions only; no account data'}`,
    c.name ? `name: ${esc(c.name)} (call them ${esc(firstName(c.name))})` : 'name: unknown',
    c.email ? `account email: ${esc(c.email)}` : null,
    c.workspace ? `workspace in scope: ${esc(c.workspace.name)} (${esc(c.workspace.id)}), role ${esc(c.role ?? 'member')}` : c.workspaces.length > 1 ? 'workspace in scope: none chosen yet — ask which one before account questions, then call choose_workspace' : null,
    c.workspaces.length > 1 ? `their workspaces: ${c.workspaces.map(w => `${esc(w.name)} (${esc(w.id)}, ${esc(w.role)})`).join('; ')}` : null,
    `content access: ${c.contentAccess ? 'allowed for the workspace in scope' : 'not allowed (ask with request_content_access when content is the likely cause)'}`,
    c.page ? `opened support from dashboard page: ${esc(c.page)}` : null,
  ].filter(Boolean);
  return `<customer>\n${lines.join('\n')}\n</customer>`;
}
