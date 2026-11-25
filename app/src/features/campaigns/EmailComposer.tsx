import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { EmailEditor, type EmailEditorRef } from '@react-email/editor'
import type {} from '@react-email/editor/extensions'
import { defaultSlashCommands, Inspector } from '@react-email/editor/ui'
import { AlignCenter, AlignLeft, AlignRight, Bold, Box, Braces, ChevronDown, Columns2, Heading2, ImagePlus, Italic, List, LoaderCircle, Minus, MousePointer2, Paperclip, Plus, Redo2, Shapes, SlidersHorizontal, Type, Undo2, UserRound, X, type LucideIcon } from 'lucide-react'
import { Button, DropdownMenu, Icon, IconButton, SkeletonText, type MenuItem } from '../../components/ui'
import { modKey, useMediaQuery } from '../../lib/media'
import { useApi } from '../../data/context'
import type { Attachment, AttachmentApi } from '../../data/types'
import { attachmentLimit, composerLoading, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS } from './copy'
import { prepareLocalImage, inlineImageSources, inlineImageHash, replaceEditorImageSources, loadInlineAttachments, cidImageSources, type ComposedDraft } from './composer-content'
import { blockHtmlToDocument, documentToBlockHtml, isBlockDocumentEmpty, type EditorNode } from './block-content'
import '@react-email/editor/themes/default.css'
import './composer.css'
import { productName } from '../../../../api/src/brand'
import { errorText } from '../../data/types'

// The composer edits block HTML: the same document agents read and write through the
// API. Opening converts block HTML to editor blocks; saving converts blocks back.
type Draft = ComposedDraft
export type EmailComposerRef = { prepare: () => Promise<Draft> }
// personalize offers {{placeholder}} insertions. The composer sits in the campaign studio (campaigns.css): from 900 px its
// tools are a floating rail at the desk's left edge (Text, Image, Components, Variables, then formatting, Undo and Redo,
// and Style), and from 1150 px the Style panel is docked open at the right edge; below 900 px the tools are a
// toolbar on the sheet and the panel opens over the page.
// knownAttachmentIds: the attachments of this draft's other versions (a merge can leave the form without an image the
// body still shows); the composer looks there for an image's attachment when attachmentIds lacks it.
type Props = { attachmentIds?: string[]; knownAttachmentIds?: string[]; attachmentApi?: AttachmentApi; initialHtml: string; disabled?: boolean; personalize?: boolean; onReady: () => void; onDirty: () => void; onAttach?: () => void; onBusy?: (busy: boolean) => void }
const linkForms = '[data-re-link-selector-form], [data-re-link-bm-form], [data-re-btn-bm-form], [data-re-img-bm-form]'
const variables = [['Name', 'name'], ['First name', 'firstName'], ['Email', 'email']] as const

// The library's slash menu reads this shared list and has no image entry, although the
// editor supports images. Route "/image" to the mounted composer's file picker. The menu
// shows titles only; a description would only feed its search, which searchTerms covers.
let pickImage: (() => void) | null = null
if (!defaultSlashCommands.some(item => item.title === 'Image')) {
  const divider = defaultSlashCommands.findIndex(item => item.title === 'Divider')
  defaultSlashCommands.splice(divider < 0 ? defaultSlashCommands.length : divider, 0, {
    title: 'Image', description: '', icon: <ImagePlus size={20} />, category: 'Media', searchTerms: ['img', 'picture', 'photo', 'upload'],
    command: ({ editor: value, range }) => { value.chain().focus().deleteRange(range).run(); pickImage?.() },
  })
}
export const EmailComposer = forwardRef<EmailComposerRef, Props>(function EmailComposer({ attachmentIds = [], knownAttachmentIds = [], attachmentApi: providedAttachmentApi, initialHtml, disabled = false, personalize = false, onReady, onDirty, onAttach, onBusy }, ref) {
  const api = useApi()
  const attachmentApi = providedAttachmentApi ?? api.attachments
  const preparing = useRef<Promise<Draft> | null>(null)
  const [initialSnapshot] = useState(() => { const known = [...new Set([...attachmentIds, ...knownAttachmentIds])]; return { html: initialHtml, attachmentIds: [...attachmentIds], hydrate: known.length > MAX_ATTACHMENTS ? [...attachmentIds] : known } })
  // Inline attachments open as data URLs and save back as their cid references.
  const cidBySource = useRef(new Map<string, string>())
  // Inline images uploaded or opened here, by source: an upload must survive a failed prepare/save before its ID
  // reaches attachmentIds, and an image removed by a save and then restored by undo must be attached again.
  const uploadedInline = useRef(new Map<string, Attachment>())
  const needsHydration = useRef(cidImageSources(initialHtml).size > 0).current
  const [hydrating, setHydrating] = useState(needsHydration)
  const [content, setContent] = useState<EditorNode>(() => blockHtmlToDocument(needsHydration ? '' : initialHtml))
  const [generation, setGeneration] = useState(0)
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const busyListener = useRef(onBusy)
  busyListener.current = onBusy
  const [error, setError] = useState('')
  const railed = useMediaQuery('(min-width: 900px)')
  const wide = useMediaQuery('(min-width: 1150px)')
  // The panel's open state: null keeps the default (docked open from 1150 px, closed below) until someone toggles it.
  const [panelChoice, setPanelChoice] = useState<boolean | null>(null)
  const panelShown = panelChoice ?? wide
  const docked = wide && panelShown
  const inspector = useRef<HTMLElement>(null)
  const editor = useRef<EmailEditorRef>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const changed = useRef(false)
  const uploads = useRef(0)
  const locked = disabled || busy || hydrating
  const [theme] = useState(() => {
    const tokens = getComputedStyle(document.documentElement)
    const fontFamily = tokens.getPropertyValue('--font-email').trim()
    const letterSpacing = tokens.getPropertyValue('--tracking-email').trim()
    const color = tokens.getPropertyValue('--color-email-text').trim()
    const backgroundColor = tokens.getPropertyValue('--color-email-surface').trim()
    // Mirrors the server renderer (api/src/campaign-blocks.ts) so the canvas matches delivered mail.
    return { extends: 'minimal' as const, styles: {
      body: { fontFamily, letterSpacing, color, backgroundColor, margin: '0', padding: '0' },
      container: { width: '100%', maxWidth: '600px', margin: '0 auto', padding: '24px' },
      paragraph: { fontFamily, letterSpacing, fontSize: '16px', lineHeight: '1.6', margin: '0 0 16px', color },
      h1: { fontFamily, letterSpacing, fontSize: '26px', lineHeight: '1.25', fontWeight: '600', margin: '0 0 20px', color },
      h2: { fontFamily, letterSpacing, fontSize: '22px', lineHeight: '1.3', fontWeight: '600', margin: '24px 0 12px', color },
      h3: { fontFamily, letterSpacing, fontSize: '18px', lineHeight: '1.4', fontWeight: '600', margin: '20px 0 12px', color },
      button: { fontFamily, letterSpacing, fontSize: '15px', backgroundColor: '#181818', color: '#ffffff', padding: '12px 20px', borderRadius: '4px' },
      link: { color: '#3156c7', textDecoration: 'underline' },
      image: { maxWidth: '100%', height: 'auto' },
      blockquote: { margin: '0 0 16px', padding: '12px 16px 4px 19px', backgroundColor: '#f4f4f4', borderRadius: '4px', color: '#595959' },
      codeBlock: { margin: '0 0 16px', padding: '14px 16px', backgroundColor: '#f4f4f4', borderRadius: '4px', fontSize: '13px', lineHeight: '1.5' },
      inlineCode: { backgroundColor: '#f4f4f4', borderRadius: '3px' },
      list: { margin: '0 0 16px', paddingLeft: '24px' },
      listItem: { fontSize: '16px', lineHeight: '1.6', margin: '0 0 6px' },
    } }
  })

  function synchronizeEditor(instance: EmailEditorRef) {
    const value = instance.editor
    if (!value) return
    // Tiptap preserves isEditable during React option updates; synchronize it explicitly.
    value.setEditable(!locked, false)
    value.setOptions({ editorProps: {
      ...value.options.editorProps,
      attributes: { 'aria-label': 'Email content', role: 'textbox', 'aria-multiline': 'true' },
      handlePaste: (_view, event) => {
        if (locked) return true
        if (event.clipboardData?.files.length) return false
        const html = event.clipboardData?.getData('text/html')
        if (!html) return false
        event.preventDefault()
        // Pasted HTML enters through the same lenient block import as API content.
        value.commands.insertContent(blockHtmlToDocument(html).content ?? [])
        return true
      },
    } })
  }
  // Run after child option reconciliation so the name and paste boundary remain installed.
  useEffect(() => { if (editor.current) synchronizeEditor(editor.current) })
  useEffect(() => {
    if (!panelShown || !inspector.current) return
    const label = () => {
      inspector.current?.querySelectorAll<HTMLInputElement>('input, select, textarea').forEach(control => {
        if (control.getAttribute('aria-label')) return
        const row = control.closest<HTMLElement>('[data-re-inspector-prop-row]')
        const text = row?.innerText?.split('\n').map(value => value.trim()).find(value => value && !/^(?:px|%|[0-9.]+)$/.test(value))
        const section = control.closest<HTMLElement>('[data-re-inspector-section]')?.innerText?.split('\n').map(value => value.trim()).find(Boolean)
        if (text) {
          const siblings = [...(row?.querySelectorAll<HTMLInputElement>('input[type=text]') ?? [])], index = siblings.indexOf(control)
          const side = siblings.length === 4 && index >= 0 ? ` ${['top', 'right', 'bottom', 'left'][index]}` : ''
          control.setAttribute('aria-label', `${section && section !== text ? `${section} ` : ''}${text}${side}${control.type === 'color' ? ' picker' : ''}`)
          return
        }
        let group = control.parentElement
        while (group && group !== inspector.current && group.querySelectorAll('input, select').length !== 4) group = group.parentElement
        if (!group || group === inspector.current) return
        const controls = [...group.querySelectorAll<HTMLInputElement>('input, select')], controlIndex = controls.indexOf(control)
        const containsSelect = controls.some(item => item.tagName === 'SELECT'), sides = ['top', 'right', 'bottom', 'left']
        if (containsSelect) {
          const sideGroups = [...(group.parentElement?.children ?? [])].filter(item => item.querySelectorAll('input, select').length === 4), side = sides[Math.max(0, sideGroups.indexOf(group))]
          control.setAttribute('aria-label', `Border ${side} ${['width', 'color picker', 'color', 'style'][controlIndex]}`)
        } else {
          let holder = group.parentElement
          while (holder && holder !== inspector.current && !/^(?:Padding|Rounded)\b/.test(holder.innerText.trim())) holder = holder.parentElement
          const property = holder?.innerText.trim().split('\n')[0] ?? section ?? 'Style'
          control.setAttribute('aria-label', `${property} ${sides[controlIndex]}`)
        }
      })
      inspector.current?.querySelectorAll<HTMLButtonElement>('button').forEach(button => {
        if (button.getAttribute('aria-label') || button.innerText.trim() || button.title) return
        const group = button.closest<HTMLElement>('[role=group]'), buttons = [...(group?.querySelectorAll<HTMLButtonElement>('button') ?? [])], index = buttons.indexOf(button)
        const section = button.closest<HTMLElement>('[data-re-inspector-section]')?.innerText?.split('\n').map(value => value.trim()).find(Boolean) ?? 'Style'
        button.setAttribute('aria-label', `${index === 0 ? 'Use uniform' : 'Use individual'} ${section.toLowerCase()} values`)
      })
    }
    label()
    const observer = new MutationObserver(label)
    observer.observe(inspector.current, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [panelShown])
  useEffect(() => {
    pickImage = () => { if (!locked) { onDirty(); fileInput.current?.click() } }
    return () => { pickImage = null }
  })

  useEffect(() => {
    const needed = cidImageSources(initialSnapshot.html)
    if (!needed.size) return
    const controller = new AbortController()
    setHydrating(true)
    loadInlineAttachments(attachmentApi, initialSnapshot.hydrate, needed, controller.signal).then(result => {
      if (controller.signal.aborted) return
      cidBySource.current = new Map([...result.sources].map(([cid, url]) => [url, cid]))
      result.items.forEach((item, url) => uploadedInline.current.set(url, item))
      setContent(replaceEditorImageSources(blockHtmlToDocument(initialSnapshot.html), result.sources) as EditorNode)
      setHydrating(false); setReady(false); setGeneration(value => value + 1)
    }).catch(cause => { if (!controller.signal.aborted) { setError(errorText(cause, 'Couldn’t load inline images.')); setContent(blockHtmlToDocument(initialSnapshot.html)); setHydrating(false); setReady(false); setGeneration(value => value + 1) } })
    return () => controller.abort()
  }, [attachmentApi, initialSnapshot])

  async function prepareContent(): Promise<Draft> {
    if (hydrating) throw new Error('Wait for inline images to finish loading before saving.')
    if (uploads.current) throw new Error('Wait for your image to finish loading before continuing.')
    const instance = editor.current
    if (!instance?.editor) throw new Error(composerLoading)
    let document = instance.getJSON() as EditorNode
    const empty = isBlockDocumentEmpty(document)
    const currentInline: string[] = []
    const allIds = new Set(attachmentIds)
    let metadata = await Promise.all([...allIds].map(id => attachmentApi.get(id)))
    const inlineSources = empty ? [] : inlineImageSources(document as Record<string, unknown>)
    for (const source of inlineSources) {
      const cached = uploadedInline.current.get(source)
      if (cached && !allIds.has(cached.id)) { metadata.push(cached); allIds.add(cached.id) }
    }
    // An inline image the body no longer uses would go out as a stray attachment. Drop the ones this editor placed
    // (bane- content IDs) or opened in the body; leave other inline attachments, set through the API, as they are.
    const opened = cidImageSources(initialSnapshot.html)
    const used = empty ? new Set<string>() : new Set([...cidImageSources(documentToBlockHtml(document)), ...inlineSources.flatMap(source => cidBySource.current.get(source)?.slice(4) ?? [])])
    const removed = metadata.filter(item => item.disposition === 'inline' && item.contentId && !used.has(item.contentId) && (item.contentId.startsWith('bane-') || opened.has(item.contentId)))
    const removedInlineIds = removed.map(item => item.id)
    if (empty) return { html: '', inlineAttachmentIds: [], removedInlineIds }
    metadata = metadata.filter(item => !removedInlineIds.includes(item.id)); removedInlineIds.forEach(id => allIds.delete(id))
    let totalSize = metadata.reduce((total, item) => total + item.size, 0)
    if (allIds.size > MAX_ATTACHMENTS || totalSize > MAX_ATTACHMENT_BYTES) throw new Error(attachmentLimit)
    const sources = new Map<string, string>(), covered = new Set(metadata.flatMap(item => item.contentId ? [item.contentId] : []))
    for (const source of inlineSources) {
      let cid = cidBySource.current.get(source)
      if (!cid) {
        const match = /^data:(image\/(?:png|jpeg|gif|webp|avif));base64,(.+)$/i.exec(source)
        if (!match) throw new Error('Unsupported inline image format.')
        const bytes = Uint8Array.from(atob(match[2]), character => character.charCodeAt(0))
        if (allIds.size >= MAX_ATTACHMENTS || totalSize + bytes.length > MAX_ATTACHMENT_BYTES) throw new Error(attachmentLimit)
        const hash = await inlineImageHash(source)
        const contentId = `bane-${crypto.randomUUID()}`
        const extension = match[1].split('/')[1] === 'jpeg' ? 'jpg' : match[1].split('/')[1]
        const item = await attachmentApi.upload(new File([bytes], `image-${hash.slice(0, 12)}.${extension}`, { type: match[1] }), { contentId })
        cid = `cid:${contentId}`
        covered.add(contentId)
        cidBySource.current.set(source, cid); uploadedInline.current.set(source, item); allIds.add(item.id); totalSize += item.size
        currentInline.push(item.id)
      } else {
        const owner = metadata.find(item => item.contentId && `cid:${item.contentId}` === cid)
        if (owner) currentInline.push(owner.id)
      }
      sources.set(source, cid)
    }
    document = replaceEditorImageSources(document as Record<string, unknown>, sources) as EditorNode
    const html = documentToBlockHtml(document)
    if (html.length > 500_000) throw new Error('This email is too large. Remove an image or shorten the content before saving.')
    // Every image the body shows is saved with its attachment, even one the form lost in a merge.
    const missing = [...cidImageSources(html)].filter(cid => !covered.has(cid)), elsewhere = knownAttachmentIds.filter(id => !allIds.has(id))
    if (missing.length && elsewhere.length) for (const item of await Promise.all(elsewhere.map(id => attachmentApi.get(id).catch(() => null)))) if (item?.contentId && missing.includes(item.contentId)) currentInline.push(item.id)
    return { html, inlineAttachmentIds: currentInline, removedInlineIds }
  }
  function prepare(): Promise<Draft> {
    if (!preparing.current) preparing.current = prepareContent().finally(() => { preparing.current = null })
    return preparing.current
  }
  useImperativeHandle(ref, () => ({ prepare }))

  const upload = useCallback(async (file: File) => {
    uploads.current += 1
    setBusy(true)
    busyListener.current?.(true)
    try { return await prepareLocalImage(file) }
    catch (cause) { const message = errorText(cause, 'Couldn’t load this image.'); setError(message); throw new Error(message) }
    finally { uploads.current -= 1; if (!uploads.current) { setBusy(false); busyListener.current?.(false) } }
  }, [])
  async function insertImage(file?: File) {
    if (!file || locked) return
    setBusy(true)
    setError('')
    try {
      const { url } = await upload(file)
      command(e => e.chain().focus().insertContent({ type: 'image', attrs: { src: url, alt: file.name.replace(/\.[^.]+$/, ''), width: '100%', alignment: 'left' } }).run(), true, true)
    } catch { /* Shown inline by the upload callback. */ }
    finally { setBusy(false); if (fileInput.current) fileInput.current.value = '' }
  }
  // Opening the Insert menu blurs the editor, which resets its selection to the document
  // start. Remember the caret while focused so menu insertions land where the user was.
  const caret = useRef<{ from: number; to: number; node: boolean } | null>(null)
  function trackCaret(instance: EmailEditorRef) {
    caret.current = null
    instance.editor?.on('transaction', ({ editor: value }) => {
      if (!value.isFocused) return
      const selection = value.state.selection
      caret.current = { from: selection.from, to: selection.to, node: selection.toJSON().type === 'node' }
    })
  }
  // The menu returns focus to its trigger in a queued task after closing; run the
  // insertion after that so the caret lands in the new block instead of on the button.
  function insertFromMenu(run: (value: NonNullable<EmailEditorRef['editor']>) => void) {
    setTimeout(() => setTimeout(() => command(run, true, true), 0), 0)
  }
  function command(run: (value: NonNullable<EmailEditorRef['editor']>) => void, insert = false, restoreCaret = false) {
    if (locked || !ready || !editor.current?.editor) return
    const instance = editor.current.editor
    if (restoreCaret && caret.current && !instance.isFocused) {
      try { if (caret.current.node) instance.commands.setNodeSelection(caret.current.from); else instance.commands.focus(caret.current.to) }
      catch { /* The remembered position no longer exists; insert at the current selection. */ }
    }
    const selection = instance.state.selection
    // Insert after selected media instead of replacing it with the new block.
    if (insert && selection.toJSON().type === 'node') {
      const after = selection.to
      instance.view.focus()
      instance.chain().insertContentAt(after, { type: 'paragraph' }).setTextSelection(after + 1).run()
    }
    run(instance)
  }
  function align(alignment: 'left' | 'center' | 'right') {
    command(instance => {
      const { state } = instance, selection = state.selection, selected = selection.toJSON().type === 'node' ? state.doc.nodeAt(selection.from) : null
      const allowed = new Set(['heading', 'paragraph', 'image', 'blockquote', 'codeBlock', 'bulletList', 'orderedList', 'listItem', 'button', 'columnsColumn'])
      if (selected && allowed.has(selected.type.name)) { instance.view.dispatch(state.tr.setNodeMarkup(selection.from, undefined, { ...selected.attrs, alignment })); instance.view.focus(); return }
      for (let depth = selection.$from.depth; depth >= 1; depth--) {
        const node = selection.$from.node(depth)
        if (!allowed.has(node.type.name)) continue
        instance.view.dispatch(state.tr.setNodeMarkup(selection.$from.before(depth), undefined, { ...node.attrs, alignment })); instance.view.focus(); return
      }
    }, false, true)
  }
  const inactive = locked || !ready
  const chooseImage = () => { if (inactive) return; onDirty(); fileInput.current?.click() }
  // The rail's Text: one click inserts at the caret (the editor keeps focus; see keepFocus).
  const insertText = () => command(e => e.chain().focus().setParagraph().run(), true, true)
  const keepFocus = (event: { target: EventTarget; preventDefault: () => void }) => { if ((event.target as HTMLElement).closest('button')) event.preventDefault() }
  // Everything the rail's Components (and the toolbar's Insert, with the variables) can add at the caret.
  const componentItems: MenuItem[] = [
    { label: 'Text', icon: <Icon icon={Type} />, onSelect: () => insertFromMenu(e => e.chain().focus().setParagraph().run()) },
    { label: 'Heading', icon: <Icon icon={Heading2} />, onSelect: () => insertFromMenu(e => e.chain().focus().setHeading({ level: 2 }).run()) },
    { label: 'Button', icon: <Icon icon={MousePointer2} />, onSelect: () => insertFromMenu(e => e.chain().focus().setButton().run()) },
    { label: 'Image', icon: <Icon icon={ImagePlus} />, onSelect: () => { onDirty(); fileInput.current?.click() } },
    { label: 'Attachment', icon: <Icon icon={Paperclip} />, disabled: !onAttach, onSelect: () => onAttach?.() },
    { label: 'Bullet list', icon: <Icon icon={List} />, onSelect: () => insertFromMenu(e => e.chain().focus().toggleBulletList().run()) },
    { label: 'Divider', icon: <Icon icon={Minus} />, onSelect: () => insertFromMenu(e => e.chain().focus().setHorizontalRule().run()) },
    { label: 'Styled section', icon: <Icon icon={Box} />, onSelect: () => insertFromMenu(e => e.chain().focus().insertSection().run()) },
    { label: '2 columns', icon: <Icon icon={Columns2} />, onSelect: () => insertFromMenu(e => e.chain().focus().insertColumns(2).run()) },
  ]
  const variableItems: MenuItem[] = personalize ? variables.map(([text, key]) => ({ label: text, icon: <Icon icon={UserRound} />, onSelect: () => insertFromMenu(e => e.chain().focus().insertContent(`{{${key}}}`).run()) })) : []
  const togglePanel = () => setPanelChoice(!panelShown)
  const fileField = <input ref={fileInput} type="file" hidden accept="image/png,image/jpeg,image/gif,image/webp,image/avif" onChange={event => void insertImage(event.target.files?.[0])} />
  const tool = (label: string, icon: LucideIcon, run: () => void, title = label) => <IconButton label={label} title={title} disabled={inactive} onClick={run}><Icon icon={icon} /></IconButton>
  return <div className="email-composer" data-inactive={locked || undefined} onClickCapture={event => { if (locked) { event.preventDefault(); event.stopPropagation() } }} onKeyDownCapture={event => {
    if (event.key === 'Escape' && (event.target as Element).closest(linkForms)) {
      event.preventDefault()
      event.stopPropagation()
      const trigger = (event.target as Element).closest('[data-re-link-selector]')?.querySelector<HTMLButtonElement>('[data-re-link-selector-trigger]')
      // These library forms stop bubbling before their own window Escape listener can run.
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      requestAnimationFrame(() => { if (trigger?.isConnected) trigger.focus(); else editor.current?.editor?.commands.focus() })
    } else if (locked) { event.preventDefault(); event.stopPropagation() }
  }}>
    {railed ? <nav className="composer-rail" aria-label="Email formatting" onMouseDown={keepFocus}>
      <div className="composer-rail__group">
        {tool('Text', Type, insertText)}
        {tool('Image', ImagePlus, chooseImage)}
        <DropdownMenu label="Components" side="right" align="start" trigger={<IconButton label="Components" disabled={inactive}><Icon icon={Shapes} /></IconButton>} items={componentItems} />
        {personalize && <DropdownMenu label="Variables" side="right" align="start" trigger={<IconButton label="Variables" disabled={inactive}><Icon icon={Braces} /></IconButton>} items={variableItems} />}
      </div>
      <div className="composer-rail__group">
        {tool('Bold', Bold, () => command(e => e.chain().focus().toggleBold().run()), `Bold ${modKey}B`)}
        {tool('Italic', Italic, () => command(e => e.chain().focus().toggleItalic().run()), `Italic ${modKey}I`)}
        {tool('Align left', AlignLeft, () => align('left'))}
        {tool('Align center', AlignCenter, () => align('center'))}
        {tool('Align right', AlignRight, () => align('right'))}
      </div>
      <div className="composer-rail__group">
        {tool('Undo', Undo2, () => command(e => e.chain().focus().undo().run()), `Undo ${modKey}Z`)}
        {tool('Redo', Redo2, () => command(e => e.chain().focus().redo().run()), `Redo ${modKey}⇧Z`)}
      </div>
      <div className="composer-rail__group">
        <IconButton label="Style" title={panelShown ? 'Hide style' : 'Show style'} disabled={inactive} aria-pressed={panelShown} onClick={togglePanel}><Icon icon={SlidersHorizontal} /></IconButton>
      </div>
      {busy && <span className="composer-rail__busy" role="status"><Icon icon={LoaderCircle} size="sm" className="ui-spinner" /><span className="sr-only">Preparing…</span></span>}
      {fileField}
    </nav> : <div className="composer-toolbar">
      <div className="composer-tools ui-scroll-fade" aria-label="Email formatting" onMouseDown={keepFocus}>
        <DropdownMenu label="Insert" align="start" trigger={<Button size="sm" variant="ghost" disabled={inactive}><Icon icon={Plus} />Insert<Icon icon={ChevronDown} size="sm" /></Button>} items={[...componentItems, ...variableItems]} />
        <div className="cluster"><IconButton size="sm" label="Bold" disabled={inactive} onClick={() => command(e => e.chain().focus().toggleBold().run())}><Icon icon={Bold} /></IconButton><IconButton size="sm" label="Italic" disabled={inactive} onClick={() => command(e => e.chain().focus().toggleItalic().run())}><Icon icon={Italic} /></IconButton></div>
        <div className="cluster"><IconButton size="sm" label="Align left" disabled={inactive} onClick={() => align('left')}><Icon icon={AlignLeft} /></IconButton><IconButton size="sm" label="Align center" disabled={inactive} onClick={() => align('center')}><Icon icon={AlignCenter} /></IconButton><IconButton size="sm" label="Align right" disabled={inactive} onClick={() => align('right')}><Icon icon={AlignRight} /></IconButton></div>
        <Button size="sm" variant="ghost" disabled={inactive} aria-pressed={panelShown} onClick={togglePanel}><Icon icon={SlidersHorizontal} />Style</Button>
        {busy && <span className="muted" role="status">Preparing…</span>}
        <div className="cluster composer-history"><IconButton size="sm" label="Undo" disabled={inactive} onClick={() => command(e => e.chain().focus().undo().run())}><Icon icon={Undo2} /></IconButton><IconButton size="sm" label="Redo" disabled={inactive} onClick={() => command(e => e.chain().focus().redo().run())}><Icon icon={Redo2} /></IconButton></div>
        {fileField}
      </div>
    </div>}
    {error && <p className="campaign-note composer-error" data-tone="danger" role="alert">{error}</p>}
    <div className="composer-visual">
      <div className="composer-canvas" onClickCapture={event => { if ((event.target as HTMLElement).closest('a')) event.preventDefault() }}>
        {!ready && <div className="composer-starting" role="status"><SkeletonText width="55%" lineHeight={36} /><SkeletonText /><SkeletonText width="80%" /><SkeletonText width="60%" /><span className="sr-only">Loading visual composer</span></div>}
        <EmailEditor key={generation} ref={editor} content={content as Record<string, unknown>} theme={theme} editable={!locked} placeholder="Write, or type / for blocks…" onUploadImage={upload} className="composer-document" onReady={instance => { synchronizeEditor(instance); trackCaret(instance); setReady(!hydrating); if (!hydrating) { console.info(`[${productName} timing] campaign editor ready`, { navigationMs: Number(performance.now().toFixed(1)) }); onReady() } }} onUpdate={() => { changed.current = true; onDirty() }}>
          <Inspector.Root ref={inspector} className="composer-inspector" hidden={!panelShown} data-docked={docked || undefined} data-closed={panelShown ? undefined : ''}>
            <div className="composer-inspector-header"><span className="composer-inspector-title">Style</span><IconButton size="sm" label="Close style" onClick={() => setPanelChoice(false)}><Icon icon={X} /></IconButton></div>
            <Inspector.Breadcrumb />
            {/* Styles are per block (api/src/block-style.ts): no document-wide controls, and a text selection offers its block's. */}
            <Inspector.Document>{() => <p className="composer-inspector-hint">Select a block to style it.</p>}</Inspector.Document>
            <Inspector.Node />
            <Inspector.Text>{() => <Inspector.Breadcrumb>{segments => { const block = segments.at(-1); return block && block.node.nodeType !== 'body' ? <Button size="sm" variant="secondary" className="composer-inspector-action" onClick={block.focus}>Style this block</Button> : null }}</Inspector.Breadcrumb>}</Inspector.Text>
          </Inspector.Root>
        </EmailEditor>
      </div>
    </div>
  </div>
})
