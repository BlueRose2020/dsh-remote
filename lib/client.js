/**
 * Browser half of `dsh-remote`: the settings card in DSH's Settings →
 * 「插件」 tab.
 *
 * Hand-written in the format the client module loader consumes
 * (`window.__ModuleLoader__.load({id, factory})`), so this plugin needs no
 * bundler: the Host serves this file verbatim as the plugin's client bundle.
 * The only module requested is `react`, which is part of the platform seed
 * table, so `dsh.client.external` stays empty.
 *
 * The card edits the Host's `remote-channel` settings namespace, which the node
 * half registers. Everything here is presentation: the Host owns the values and
 * the transports, and this file only writes the switches and the two write-only
 * passwords.
 */
window.__ModuleLoader__.load({
  id: 'dsh-remote',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const NS = 'remote-channel'

    const MUTED = 'var(--dsw-alias-label-secondary, rgba(128,128,128,0.95))'
    const TEXT = 'var(--dsw-alias-label-primary, inherit)'
    const BORDER = 'var(--dsw-alias-border-l4, rgba(128,128,128,0.28))'
    const ACCENT = 'var(--dsw-alias-brand-primary, #4c8dff)'
    const SURFACE = 'var(--dsw-alias-bg-base, #ffffff)'

    /** 64x64 of the bundled card avatar, kept in sync with `default.png`. */
    const DEFAULT_AVATAR = 'data:image/jpeg;base64,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'

    /** `开` / `关`, for the one-line summary. */
    const onOff = (value) => (value === false ? '关' : '开')

    /** The size the cropped avatar is stored at: plenty for a 72px card header. */
    const AVATAR_SIZE = 192

    // ------------------------------------------------------------- stylesheet
    const STYLE_ID = 'dsh-remote-style'

    /**
     * The plugin's stylesheet, injected once.
     *
     * Inline styles cannot express `:hover`, `:focus-visible` or a transition, and
     * a settings panel that does not react to the pointer reads as a fake — which
     * is exactly what "美化 UI" was pointing at. Every rule is namespaced `rc-` so
     * nothing leaks into the app around it, and the colours come from DSH's own
     * theme aliases so light/dark follow the app instead of fighting it.
     */
    const STYLES = `
.rc-chip{display:inline-flex;align-items:center;gap:6px;padding:2px 9px 2px 2px;height:28px;
  background:transparent;border:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.3));
  border-radius:999px;color:var(--dsw-alias-label-primary,inherit);cursor:pointer;font:inherit;
  transition:background .15s ease,border-color .15s ease,box-shadow .15s ease}
.rc-chip:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));
  border-color:var(--dsw-alias-brand-primary,#4c8dff);
  box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary,#4c8dff) 14%,transparent)}
.rc-chip.off{opacity:.72}
.rc-chip-avatar{width:22px;height:22px;border-radius:50%;object-fit:cover;display:block}
.rc-chip-name{font-size:12px;color:var(--dsw-alias-label-secondary,rgba(128,128,128,.95));
  max-width:92px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rc-dot{width:6px;height:6px;border-radius:50%;flex:none;
  background:var(--dsw-alias-state-success-primary,#22c55e);
  box-shadow:0 0 0 2px var(--dsw-alias-bg-base,#fff)}
.rc-dot.dim{background:var(--dsw-alias-label-dimmed,#9aa0a6)}
.rc-pop{position:absolute;right:0;top:34px;width:332px;z-index:60;
  background:var(--dsw-alias-bg-base,#fff);border:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.26));
  border-radius:14px;box-shadow:0 14px 44px rgba(0,0,0,.24);overflow:hidden;
  animation:rc-pop .14s ease-out}
@keyframes rc-pop{from{opacity:0;transform:translateY(-5px) scale(.985)}to{opacity:1;transform:none}}
.rc-pop-head{display:flex;align-items:center;gap:11px;padding:13px 14px;
  border-bottom:.5px solid var(--dsw-alias-border-l4,rgba(128,128,128,.22))}
.rc-avatar{border-radius:50%;object-fit:cover;display:block;flex:none;
  background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}
.rc-avatar.ring{box-shadow:0 0 0 2px var(--dsw-alias-bg-base,#fff),0 0 0 3.5px var(--dsw-alias-brand-primary,#4c8dff)}
.rc-title{font-weight:650;font-size:14px;color:var(--dsw-alias-label-primary,inherit)}
.rc-sub{font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-secondary,rgba(128,128,128,.95));
  overflow:hidden;text-overflow:ellipsis}
.rc-row{display:flex;align-items:center;gap:10px;padding:9px 14px;cursor:pointer;
  transition:background .12s ease}
.rc-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.09))}
.rc-row.disabled{opacity:.55;cursor:default}
.rc-row.dimmed{opacity:.62}
.rc-row-label{font-weight:600;font-size:13px;color:var(--dsw-alias-label-primary,inherit)}
.rc-hint{margin-left:auto;font-size:11.5px;color:var(--dsw-alias-label-secondary,rgba(128,128,128,.95))}
.rc-switch{position:relative;flex:none;width:36px;height:21px;border-radius:999px;
  background:var(--dsw-alias-border-l2,rgba(128,128,128,.38));transition:background .16s ease}
.rc-switch.on{background:var(--dsw-alias-brand-primary,#4c8dff)}
.rc-switch::after{content:'';position:absolute;top:2px;left:2px;width:17px;height:17px;border-radius:50%;
  background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.32);transition:transform .16s ease}
.rc-switch.on::after{transform:translateX(15px)}
.rc-switch input{position:absolute;inset:0;width:100%;height:100%;opacity:0;margin:0;cursor:pointer}
.rc-switch input:disabled{cursor:default}
.rc-modes{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:10px 14px;
  border-top:.5px solid var(--dsw-alias-border-l4,rgba(128,128,128,.22))}
.rc-foot{padding:9px 14px;border-top:.5px solid var(--dsw-alias-border-l4,rgba(128,128,128,.22));
  font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-secondary,rgba(128,128,128,.95))}
.rc-pill{font:inherit;font-size:12px;cursor:pointer;border-radius:999px;padding:3px 11px;
  color:var(--dsw-alias-label-primary,inherit);background:transparent;
  border:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.3));transition:all .14s ease}
.rc-pill:hover{border-color:var(--dsw-alias-brand-primary,#4c8dff);
  color:var(--dsw-alias-brand-primary,#4c8dff)}
.rc-pill.active{background:var(--dsw-alias-brand-primary,#4c8dff);
  border-color:var(--dsw-alias-brand-primary,#4c8dff);color:#fff;font-weight:600}
.rc-pill:disabled{cursor:default;opacity:.6}
.rc-btn{font:inherit;font-size:12.5px;cursor:pointer;border-radius:9px;padding:5px 12px;
  background:transparent;color:var(--dsw-alias-label-primary,inherit);
  border:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.3));transition:all .14s ease}
.rc-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary,#4c8dff);
  color:var(--dsw-alias-brand-primary,#4c8dff)}
.rc-btn:disabled{cursor:default;opacity:.55}
.rc-btn.primary{background:var(--dsw-alias-brand-primary,#4c8dff);border-color:transparent;color:#fff;font-weight:600}
.rc-btn.primary:hover:not(:disabled){filter:brightness(1.07);color:#fff}
.rc-btn.wide{display:block;width:calc(100% - 28px);margin:2px 14px 12px;text-align:center}
.rc-overlay{position:fixed;inset:0;z-index:200;display:flex;align-items:center;justify-content:center;
  padding:24px;background:rgba(12,14,17,.46);backdrop-filter:blur(3px);animation:rc-fade .16s ease-out}
@keyframes rc-fade{from{opacity:0}to{opacity:1}}
.rc-sheet{display:flex;flex-direction:column;width:min(780px,94vw);max-height:88vh;overflow:hidden;
  background:var(--dsw-alias-bg-base,#fff);border:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.26));
  border-radius:16px;box-shadow:0 28px 70px rgba(0,0,0,.36);animation:rc-rise .18s ease-out}
@keyframes rc-rise{from{opacity:0;transform:translateY(10px) scale(.99)}to{opacity:1;transform:none}}
.rc-sheet-head{display:flex;align-items:center;gap:12px;padding:16px 18px;
  border-bottom:.5px solid var(--dsw-alias-border-l4,rgba(128,128,128,.22))}
.rc-tabs{display:flex;flex-wrap:wrap;gap:6px;padding:10px 18px;
  border-bottom:.5px solid var(--dsw-alias-border-l4,rgba(128,128,128,.22))}
.rc-body{overflow-y:auto;padding-bottom:20px}
.rc-section{padding:16px 18px 5px;font-size:11px;font-weight:700;letter-spacing:.07em;
  text-transform:uppercase;color:var(--dsw-alias-label-secondary,rgba(128,128,128,.95))}
.rc-card{margin:4px 18px 12px;border:.5px solid var(--dsw-alias-border-l4,rgba(128,128,128,.22));
  border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-base,#fff)}
.rc-card>*+*{border-top:.5px solid var(--dsw-alias-border-l4,rgba(128,128,128,.16))}
.rc-field{padding:11px 14px}
.rc-field-top{display:flex;align-items:center;gap:10px}
.rc-field-label{font-weight:600;font-size:13px;color:var(--dsw-alias-label-primary,inherit)}
.rc-field-value{margin-left:auto;display:flex;align-items:center;gap:8px}
.rc-help{margin-top:5px;font-size:11.5px;line-height:1.65;
  color:var(--dsw-alias-label-secondary,rgba(128,128,128,.95))}
.rc-input,.rc-select,.rc-textarea{font:inherit;font-size:13px;color:var(--dsw-alias-label-primary,inherit);
  background:transparent;border:.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.3));
  border-radius:8px;padding:5px 8px;transition:border-color .14s ease,box-shadow .14s ease}
.rc-input{width:180px}
.rc-input:focus,.rc-select:focus,.rc-textarea:focus{outline:none;
  border-color:var(--dsw-alias-brand-primary,#4c8dff);
  box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary,#4c8dff) 16%,transparent)}
.rc-textarea{width:100%;min-height:78px;line-height:1.65;resize:vertical;box-sizing:border-box}
.rc-note{margin:12px 18px;padding:9px 11px;border:.5px solid var(--dsw-alias-border-l4,rgba(128,128,128,.22));
  border-radius:10px;font-size:11.5px;line-height:1.65;
  background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.06));
  color:var(--dsw-alias-label-secondary,rgba(128,128,128,.95))}
.rc-tree-row{position:relative;display:flex;width:100%;gap:8px;align-items:center;
  min-height:26px;padding:5px 18px;background:transparent;cursor:pointer;font:inherit;
  text-align:left;color:var(--dsw-alias-label-primary,inherit);
  transition:background .12s ease}
.rc-tree-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.08))}
.rc-tree-row.dim:hover{background:transparent}
.rc-tree-row.active{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.11))}
/* The current target gets a bar down the edge as well as the tinted row: with a
   tree this is the one thing that must never be ambiguous. */
.rc-tree-row.active::before{content:'';position:absolute;left:6px;top:5px;bottom:5px;width:2px;
  border-radius:2px;background:var(--dsw-alias-brand-primary,#4c8dff)}
.rc-tree-name{flex:0 1 auto;font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap}
.rc-tree-row.dim{cursor:default}
.rc-tree-row.dim .rc-tree-name{color:var(--dsw-alias-label-secondary,rgba(128,128,128,.95));font-weight:400}
.rc-tree-marks{flex:none;margin-left:auto;font-size:11px;letter-spacing:.01em;
  color:var(--dsw-alias-label-secondary,rgba(128,128,128,.95));white-space:nowrap}
.rc-tree-row.active .rc-tree-name{font-weight:650}
.rc-tree-row.active .rc-tree-marks{color:var(--dsw-alias-brand-primary,#4c8dff)}
.rc-tree-guide{flex:none;align-self:stretch;width:18px;box-sizing:border-box;
  border-left:.5px solid var(--dsw-alias-border-l4,rgba(128,128,128,.24))}
.rc-tree-gutter{border-radius:6px}
.rc-tree-gutter:hover .rc-chevron{color:var(--dsw-alias-label-primary,inherit)}
.rc-tree-total{flex:none;font-size:10.5px;font-variant-numeric:tabular-nums;
  color:var(--dsw-alias-label-dimmed,rgba(128,128,128,.75))}
.rc-tree-group{display:flex;align-items:center;gap:8px;min-height:26px;padding:10px 18px 2px;
  font-size:11.5px;font-weight:700;letter-spacing:.04em;
  color:var(--dsw-alias-label-secondary,rgba(128,128,128,.95))}
.rc-tree-group-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rc-tree-caret{flex:none;display:inline-flex;align-items:center;justify-content:center;
  width:18px;height:18px;padding:0;border:none;border-radius:5px;background:transparent;
  color:var(--dsw-alias-label-secondary,rgba(128,128,128,.95));cursor:pointer;font:inherit;
  transition:background .12s ease,color .12s ease}
.rc-tree-caret:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14));
  color:var(--dsw-alias-label-primary,inherit)}
.rc-tree-caret.empty{visibility:hidden;cursor:default}
/* A CSS chevron, not a glyph: it cannot be missing from a font, and rotating it is
   what makes a fold feel like a fold. */
.rc-chevron{width:6px;height:6px;border-right:1.6px solid currentColor;
  border-bottom:1.6px solid currentColor;transform:rotate(45deg) translate(-1px,-1px);
  transition:transform .16s ease}
.rc-tree-caret.folded .rc-chevron{transform:rotate(-45deg) translate(-1px,0)}
.rc-tree-count{flex:none;font-size:10.5px;font-variant-numeric:tabular-nums;padding:1px 6px;
  border-radius:999px;background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.13));
  color:var(--dsw-alias-label-secondary,rgba(128,128,128,.95))}
.rc-tree-covers{flex:none;font-size:10.5px;color:var(--dsw-alias-brand-primary,#4c8dff)}
.rc-tree-tools{display:flex;align-items:center;gap:8px;padding:10px 18px 0}
.rc-actions{padding:14px 18px}
.rc-swatch{width:48px;height:48px;border-radius:50%;object-fit:cover;display:block;
  border:.5px solid var(--dsw-alias-border-l4,rgba(128,128,128,.28))}
.rc-file{color:var(--dsw-alias-label-secondary,rgba(128,128,128,.95));font-size:12px;max-width:190px}
.rc-crop{display:flex;flex-direction:column;align-items:center;gap:14px;padding:18px}
.rc-crop-stage{position:relative;border-radius:50%;overflow:hidden;cursor:grab;touch-action:none;
  background:#0b0d10;box-shadow:0 0 0 9999px rgba(0,0,0,.6),inset 0 0 0 2px rgba(255,255,255,.9)}
.rc-crop-stage:active{cursor:grabbing}
.rc-crop-stage img{position:absolute;max-width:none;user-select:none;pointer-events:none;-webkit-user-drag:none}
.rc-crop-tools{display:flex;align-items:center;gap:12px;justify-content:center;flex-wrap:wrap}
.rc-range{width:170px;accent-color:var(--dsw-alias-brand-primary,#4c8dff)}
.rc-crop-title{font-size:13px;font-weight:650;color:var(--dsw-alias-label-primary,inherit)}
.rc-crop-hint{font-size:11.5px;color:var(--dsw-alias-label-secondary,rgba(128,128,128,.95))}
`

    /**
     * Make sure the document carries *this* revision of the stylesheet.
     *
     * Not `if (already there) return`: a hot reload swaps the module without
     * touching the document, so a tag from an earlier revision is still there and
     * the new rules would never arrive. Reconciling by content is the only version
     * that survives both a reload and a hot reload.
     * @returns which of the three cases happened, for the probe below.
     */
    function ensureStyles() {
      if (typeof document === 'undefined') return 'no-document'
      const existing = document.getElementById(STYLE_ID)
      if (existing === null) {
        const style = document.createElement('style')
        style.id = STYLE_ID
        style.textContent = STYLES
        document.head.appendChild(style)
        return 'injected'
      }
      if (existing.textContent === STYLES) return 'current'
      existing.textContent = STYLES
      return 'refreshed'
    }

    /**
     * Inline geometry for the fold control.
     *
     * The caret, its chevron and the indent guides are structure, not decoration: if
     * a rule goes missing the caret turns into a browser-default button box and the
     * tree stops reading as a tree (which is what happened). Inline styles win over
     * every stylesheet, so the shape survives a stale stylesheet, a theme rule, or a
     * future refactor of the CSS. Colour, hover and transitions stay in the
     * stylesheet, where they belong.
     */
    const CARET_STYLE = {
      flex: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: '18px', height: '18px', padding: '0', margin: '0', border: 'none',
      background: 'transparent', color: 'inherit', cursor: 'pointer', font: 'inherit',
      lineHeight: '1', appearance: 'none', WebkitAppearance: 'none',
    }
    const CHEVRON_STYLE = {
      width: '6px', height: '6px',
      borderRight: '1.6px solid currentColor', borderBottom: '1.6px solid currentColor',
      transition: 'transform .16s ease', transform: 'rotate(45deg) translate(-1px, -1px)',
    }
    const CHEVRON_FOLDED_STYLE = {
      ...CHEVRON_STYLE, transform: 'rotate(-45deg) translate(-1px, 0)',
    }
    const GUIDE_STYLE = {
      flex: 'none', alignSelf: 'stretch', width: '18px', boxSizing: 'border-box',
      borderLeft: '0.5px solid var(--dsw-alias-border-l4, rgba(128,128,128,0.24))',
    }

    // ------------------------------------------------------------------ atoms
    /**
     * One switch row.
     *
     * The control is a real checkbox under a styled track: keyboard and assistive
     * tech keep working, and the pointer gets a switch that looks like one.
     */
    function Row(props) {
      const { label, hint, checked, disabled, dimmed, onToggle } = props
      const classes = ['rc-row']
      if (disabled) classes.push('disabled')
      if (dimmed && !disabled) classes.push('dimmed')
      return react.createElement('label', { className: classes.join(' ') }, [
        react.createElement('span', {
          key: 'switch',
          className: `rc-switch${checked === true ? ' on' : ''}`,
        }, react.createElement('input', {
          key: 'box',
          type: 'checkbox',
          checked: checked === true,
          disabled: disabled === true,
          onChange: (event) => onToggle(event.target.checked),
        })),
        react.createElement('span', { key: 'label', className: 'rc-row-label' }, label),
        hint === undefined || hint === '' ? null : react.createElement('span', {
          key: 'hint', className: 'rc-hint',
        }, hint),
      ])
    }

    /**
     * A write-only secret row: the stored value never comes back, so the input is
     * blank until typed and a blank draft writes nothing.
     */
    function SecretRow(props) {
      const { label, hint, disabled, onWrite } = props
      const [draft, setDraft] = react.useState('')
      const commit = () => {
        const value = draft
        if (value === '') return
        setDraft('')
        onWrite(value)
      }
      return react.createElement('label', { className: `rc-row${disabled ? ' disabled' : ''}` }, [
        react.createElement('span', { key: 'label', className: 'rc-row-label' }, label),
        react.createElement('input', {
          key: 'input',
          type: 'password',
          className: 'rc-input',
          value: draft,
          disabled: disabled === true,
          placeholder: hint,
          onChange: (event) => setDraft(event.target.value),
          onBlur: commit,
          onKeyDown: (event) => {
            if (event.key === 'Enter') commit()
          },
        }),
      ])
    }

    /** One labelled text row that commits on Enter or blur. */
    function TextRow(props) {
      const { label, hint, value, disabled, onWrite } = props
      const [draft, setDraft] = react.useState(null)
      const shown = draft === null ? (value ?? '') : draft
      const commit = () => {
        if (draft === null) return
        const next = draft
        setDraft(null)
        if (next !== (value ?? '')) onWrite(next)
      }
      return react.createElement('label', {
        className: `rc-row${disabled ? ' disabled' : ''}`,
      }, [
        react.createElement('span', { key: 'label', className: 'rc-row-label' }, label),
        react.createElement('input', {
          key: 'input',
          type: 'text',
          className: 'rc-input',
          value: shown,
          disabled: disabled === true,
          placeholder: hint,
          onChange: (event) => setDraft(event.target.value),
          onBlur: commit,
          onKeyDown: (event) => {
            if (event.key === 'Enter') commit()
          },
        }),
      ])
    }

    /** A section heading inside the page. */
    function SectionLabel(props) {
      return react.createElement('div', { className: 'rc-section' }, props.text)
    }

    /** The one-line explanation box used next to a control. */
    function Note(props) {
      return react.createElement('div', { className: 'rc-note' }, props.text)
    }

    /** One control row: label on the left, whatever the caller passes on the right. */
    function Field(props) {
      const { label, help, children } = props
      return react.createElement('div', { className: 'rc-field' }, [
        react.createElement('div', { key: 'top', className: 'rc-field-top' }, [
          react.createElement('span', { key: 'l', className: 'rc-field-label' }, label),
          react.createElement('span', { key: 'v', className: 'rc-field-value' }, children),
        ]),
        help === undefined || help === '' ? null : react.createElement('div', {
          key: 'h', className: 'rc-help',
        }, help),
      ])
    }

    // -------------------------------------------------------------- avatar crop
    /**
     * Read a picked picture and hand back a loaded element plus its natural size.
     *
     * The size matters before anything is drawn: the crop maths works in source
     * pixels, so the picture has to be decoded before the dialog opens.
     * @param file - the file the operator picked.
     * @param done - receives `{src, el, width, height}`.
     */
    function readImageFile(file, done) {
      const reader = new FileReader()
      reader.onload = () => {
        const el = new Image()
        el.onload = () => {
          done({
            src: String(reader.result),
            el,
            width: el.naturalWidth || el.width,
            height: el.naturalHeight || el.height,
          })
        }
        el.src = String(reader.result)
      }
      reader.readAsDataURL(file)
    }

    /**
     * Which square of the picture the round crop stage is showing.
     *
     * The stage shows a `view`-pixel square, the picture is scaled to *cover* it,
     * and `(x, y)` is how far the picture has been dragged inside it. Working in
     * source pixels here (and not screen pixels) is what lets the maths be checked
     * without a browser: hand it `{width, height}` and the same numbers come out.
     * @returns `{sx, sy, side, scale, width, height}` in source pixels.
     */
    function cropSourceRect(image, view, zoom, x, y) {
      const w = Math.max(1, Number(image?.width) || 1)
      const h = Math.max(1, Number(image?.height) || 1)
      const scale = Math.max(1, Number(zoom) || 1) * (view / Math.min(w, h))
      const side = Math.min(Math.min(w, h), view / scale)
      const centreX = w / 2 - x / scale
      const centreY = h / 2 - y / scale
      const sx = Math.min(Math.max(0, centreX - side / 2), Math.max(0, w - side))
      const sy = Math.min(Math.max(0, centreY - side / 2), Math.max(0, h - side))
      return { sx, sy, side, scale, width: w * scale, height: h * scale }
    }

    /** Keep the picture covering the stage: the pan can never expose a corner. */
    function clampPan(displayedWidth, displayedHeight, view, x, y) {
      const maxX = Math.max(0, (displayedWidth - view) / 2)
      const maxY = Math.max(0, (displayedHeight - view) / 2)
      return {
        x: Math.min(maxX, Math.max(-maxX, Number(x) || 0)),
        y: Math.min(maxY, Math.max(-maxY, Number(y) || 0)),
      }
    }

    /**
     * The crop dialog: pick the region, like every chat app's avatar editor.
     *
     * Drag to move, slider (or wheel) to zoom, and only the circle inside the mask
     * is kept — the operator asked for "the selected region of the picture", not
     * for whatever a centre crop happened to include.
     */
    function CropDialog(props) {
      const { image, src, width, height, disabled, onCancel, onDone } = props
      const view = 248
      const [zoom, setZoom] = react.useState(1)
      const [pan, setPan] = react.useState({ x: 0, y: 0 })
      const [drag, setDrag] = react.useState(null)
      const rect = cropSourceRect({ width, height }, view, zoom, pan.x, pan.y)
      const setBoth = (nextZoom, nextPan) => {
        const moved = cropSourceRect({ width, height }, view, nextZoom, nextPan.x, nextPan.y)
        setPan(clampPan(moved.width, moved.height, view, nextPan.x, nextPan.y))
      }
      const confirm = () => {
        const crop = cropSourceRect({ width, height }, view, zoom, pan.x, pan.y)
        const canvas = document.createElement('canvas')
        canvas.width = AVATAR_SIZE
        canvas.height = AVATAR_SIZE
        const context = canvas.getContext('2d')
        context.drawImage(
          image, crop.sx, crop.sy, crop.side, crop.side,
          0, 0, AVATAR_SIZE, AVATAR_SIZE,
        )
        onDone(canvas.toDataURL('image/jpeg', 0.92))
      }
      const stage = react.createElement('div', {
        className: 'rc-crop-stage',
        style: { width: `${view}px`, height: `${view}px` },
        onPointerDown: (event) => {
          if (disabled) return
          event.currentTarget.setPointerCapture?.(event.pointerId)
          setDrag({ x0: event.clientX, y0: event.clientY, px: pan.x, py: pan.y })
        },
        onPointerMove: (event) => {
          if (drag === null || disabled) return
          setBoth(zoom, { x: drag.px + (event.clientX - drag.x0), y: drag.py + (event.clientY - drag.y0) })
        },
        onPointerUp: () => setDrag(null),
        onPointerCancel: () => setDrag(null),
        onWheel: (event) => {
          if (disabled) return
          const next = Math.min(4, Math.max(1, zoom + (event.deltaY < 0 ? 0.12 : -0.12)))
          setZoom(next)
          setBoth(next, pan)
        },
      }, [
        react.createElement('img', {
          key: 'img',
          src,
          alt: '',
          draggable: false,
          style: {
            width: `${rect.width}px`,
            height: `${rect.height}px`,
            left: `${(view - rect.width) / 2 + pan.x}px`,
            top: `${(view - rect.height) / 2 + pan.y}px`,
          },
        }),
      ])
      return react.createElement('div', { className: 'rc-crop' }, [
        react.createElement('div', { key: 't', className: 'rc-crop-title' }, '选择头像区域'),
        stage,
        react.createElement('div', { key: 'tools', className: 'rc-crop-tools' }, [
          react.createElement('span', { key: 'zl', className: 'rc-crop-hint' }, '缩放'),
          react.createElement('input', {
            key: 'z',
            className: 'rc-range',
            type: 'range',
            min: '1',
            max: '4',
            step: '0.02',
            value: String(zoom),
            disabled,
            onChange: (event) => {
              const next = Number(event.target.value)
              setZoom(next)
              setBoth(next, pan)
            },
          }),
          react.createElement('button', {
            key: 'reset',
            type: 'button',
            className: 'rc-btn',
            disabled,
            onClick: () => {
              setZoom(1)
              setPan({ x: 0, y: 0 })
            },
          }, '复位'),
        ]),
        react.createElement('div', { key: 'hint', className: 'rc-crop-hint' }, '拖动图片选区域，圆内就是头像'),
        react.createElement('div', { key: 'actions', className: 'rc-crop-tools' }, [
          react.createElement('button', {
            key: 'cancel', type: 'button', className: 'rc-btn', onClick: onCancel,
          }, '取消'),
          react.createElement('button', {
            key: 'ok', type: 'button', className: 'rc-btn primary', disabled, onClick: confirm,
          }, '确定'),
        ]),
      ])
    }

    // ------------------------------------------------------------ session tree
    /** Parse a settings JSON blob, falling back when it is missing or broken. */
    function parseJson(text, fallback) {
      if (typeof text !== 'string' || text.trim() === '') return fallback
      try {
        const parsed = JSON.parse(text)
        return parsed === null || typeof parsed !== 'object' ? fallback : parsed
      } catch {
        return fallback
      }
    }

    /** `刚刚 / 12 分钟前 / 3 小时前 / 2 天前` — the list is about recency. */
    function relativeTime(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return ''
      const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000))
      if (seconds < 60) return '刚刚'
      const minutes = Math.round(seconds / 60)
      if (minutes < 60) return `${minutes} 分钟前`
      const hours = Math.round(minutes / 60)
      if (hours < 24) return `${hours} 小时前`
      return `${Math.round(hours / 24)} 天前`
    }

    /** An empty session snapshot, so the page also renders outside the real slot. */
    const EMPTY_SESSIONS = { ids: [], byId: {}, current: undefined }
    const NO_STORE = (selector) => (typeof selector === 'function' ? selector(EMPTY_SESSIONS) : EMPTY_SESSIONS)

    /**
     * Rows for both session trees, from the browser's own session snapshot.
     *
     * No host round trip: the page is already inside the app that owns this data.
     * The builder retains both workspace and lineage projections for focused
     * checks, while the page renders the workspace projection only: it already
     * nests forks/subagents and avoids showing every session twice.
     * Every row also carries what folding needs: a `key` unique across both
     * trees, the `parentKey` it hangs under, and whether anything hangs under *it*.
     * Archived sessions stay out of this active navigation surface, except for a
     * pinned archived target: hiding the session currently receiving remote input
     * would make it impossible to understand or clear that selection.
     * @returns `{lineage, grouped}` arrays of rows.
     */
    function treeRows(sessions, workspaces, pinId, archivedSessionIds = []) {
      const byId = (sessions && sessions.byId) || {}
      const ids = Array.isArray(sessions && sessions.ids) && sessions.ids.length > 0
        ? sessions.ids
        : Object.keys(byId)
      const archived = new Set(Array.isArray(archivedSessionIds) ? archivedSessionIds : [])
      const nodes = ids
        .map((id) => byId[id])
        .filter((node) => node !== undefined && node !== null)
        .filter((node) => !archived.has(node.id) || node.id === pinId)
      const known = new Set(nodes.map((node) => node.id))
      const children = new Map()
      const roots = []
      for (const node of nodes) {
        const parent = node.parentId
        if (parent !== undefined && parent !== null && known.has(parent)) {
          const list = children.get(parent) || []
          list.push(node)
          children.set(parent, list)
        } else {
          roots.push(node)
        }
      }
      const labelOf = (node) => node.displayTitle || node.title || node.id
      const marksOf = (node) => {
        const marks = []
        marks.push(node.running === true ? '● 运行中' : '○ 空闲')
        const when = relativeTime(node.updatedAt)
        if (when !== '') marks.push(when)
        if (node.origin === 'subagent') marks.push('子代理')
        else if (node.parentId !== undefined && node.parentId !== null) marks.push('分叉')
        if (node.id === pinId) marks.push('← 当前')
        return marks.join(' · ')
      }
      const emit = (target, prefix, node, claimed, parentKey, depth) => {
        if (claimed !== null) claimed.add(node.id)
        const key = `${prefix}-${node.id}`
        target.push({
          key,
          kind: 'node',
          id: node.id,
          label: labelOf(node),
          marks: marksOf(node),
          subagent: node.origin === 'subagent',
          parentKey,
          depth,
        })
        // No `├─`/`└─` here on purpose: the web tree indents by depth and lets CSS
        // draw the hierarchy. Brackets belong on the phone card, where there is no
        // padding or chevron to do the job.
        ;(children.get(node.id) || []).forEach((kid) => {
          emit(target, prefix, kid, claimed, key, depth + 1)
        })
      }
      /**
       * Mark the rows something hangs under, so only those get a caret, and count
       * the direct children (a workspace header says how many sessions it holds).
       */
      const finalize = (rows) => {
        const parents = new Set()
        const counts = new Map()
        for (const row of rows) {
          const parent = row.parentKey
          if (parent === null || parent === undefined) continue
          parents.add(parent)
          counts.set(parent, (counts.get(parent) ?? 0) + 1)
        }
        return rows.map((row) => ({
          ...row,
          hasChildren: parents.has(row.key),
          childCount: counts.get(row.key) ?? 0,
        }))
      }
      const lineage = []
      roots.forEach((root) => emit(lineage, 'l', root, null, null, 0))

      const grouped = []
      const claimed = new Set()
      const nodeById = new Map(nodes.map((node) => [node.id, node]))
      const list = Array.isArray(workspaces) ? workspaces : []
      for (const [workspaceIndex, workspace] of list.entries()) {
        const members = (Array.isArray(workspace.sessionIds) ? workspace.sessionIds : [])
          .filter((id) => nodeById.has(id))
        if (members.length === 0) continue
        const memberSet = new Set(members)
        // The workspace header is the parent of everything inside it, which is
        // what lets one click fold a whole workspace away.
        // WorkspaceView calls this `workspaceId` (not `id`). Keep the index as a
        // final disambiguator so malformed/legacy rows can never poison React's
        // reconciliation or make one fold toggle every workspace at once.
        const workspaceIdentity = workspace.workspaceId ?? workspace.id ?? workspace.path ?? workspace.title ?? 'workspace'
        const groupKey = `g-ws-${String(workspaceIdentity)}-${workspaceIndex}`
        grouped.push({
          key: groupKey,
          kind: 'group',
          label: workspace.title || workspace.path || '工作区',
          parentKey: null,
          depth: 0,
        })
        for (const id of members) {
          const node = nodeById.get(id)
          if (node.parentId !== undefined && node.parentId !== null && memberSet.has(node.parentId)) continue
          if (claimed.has(node.id)) continue
          emit(grouped, 'g', node, claimed, groupKey, 1)
        }
      }
      const stray = roots.filter((node) => !claimed.has(node.id))
      if (stray.length > 0) {
        grouped.push({ key: 'g-ws-none', kind: 'group', label: '未分组', parentKey: null, depth: 0 })
        stray.forEach((node) => emit(grouped, 'g', node, claimed, 'g-ws-none', 1))
      }
      return { lineage: finalize(lineage), grouped: finalize(grouped) }
    }

    /**
     * The rows left visible with some nodes folded.
     *
     * A folded node hides its whole subtree, not just its direct children — which
     * is why this walks *all* ancestors instead of checking the immediate parent.
     * @param rows - one tree's rows.
     * @param collapsed - a Set of folded row keys.
     * @returns the rows to render, in order.
     */
    function visibleRows(rows, collapsed) {
      if (collapsed.size === 0) return rows
      const byKey = new Map(rows.map((row) => [row.key, row]))
      return rows.filter((row) => {
        let cursor = row.parentKey
        while (cursor !== null && cursor !== undefined) {
          if (collapsed.has(cursor)) return false
          const parent = byKey.get(cursor)
          cursor = parent === undefined ? null : parent.parentKey
        }
        return true
      })
    }

    /**
     * Per-row fold facts, in one pass.
     *
     * `hidden` is how many rows a *folded* row is hiding (the `+3` pill). `covers`
     * is true when the row hides the session the phone is currently talking to —
     * without it, folding a branch makes the current target disappear from the tree
     * and the operator has no way to see where their commands are going.
     * @param rows - one tree's rows.
     * @param collapsed - a Set of folded row keys.
     * @param pinId - the pinned session id, if any.
     * @returns a Map of row key to `{hidden, covers}`.
     */
    function foldFacts(rows, collapsed, pinId) {
      const byKey = new Map(rows.map((row) => [row.key, row]))
      const facts = new Map(rows.map((row) => [row.key, { hidden: 0, covers: false }]))
      for (const row of rows) {
        let cursor = row.parentKey
        while (cursor !== null && cursor !== undefined) {
          const ancestor = byKey.get(cursor)
          if (ancestor === undefined) break
          if (collapsed.has(cursor)) {
            const fact = facts.get(cursor)
            if (fact !== undefined) fact.hidden += 1
          }
          if (pinId !== undefined && pinId !== null && pinId !== ''
            && row.id === pinId && collapsed.has(cursor)) {
            const fact = facts.get(cursor)
            if (fact !== undefined) fact.covers = true
          }
          cursor = ancestor.parentKey
        }
      }
      return facts
    }

    /**
     * One tree row: a caret that folds, and a body that pins the session.
     *
     * The caret stops the event, or folding a node would also switch the remote
     * target to it — two actions that must stay separate.
     */
    function TreeRow(props) {
      const { row, active, collapsed, hidden, covers, onToggleFold, onClick } = props
      const selectable = row.kind === 'node' && row.subagent !== true && typeof onClick === 'function'
      const caret = react.createElement('button', {
        key: 'caret',
        type: 'button',
        className: `rc-tree-caret${row.hasChildren ? '' : ' empty'}${collapsed ? ' folded' : ''}`,
        title: row.hasChildren ? (collapsed ? '展开' : '折叠') : '',
        'aria-expanded': row.hasChildren ? !collapsed : undefined,
        'data-row': row.key,
        tabIndex: row.hasChildren ? 0 : -1,
        // A leaf keeps its slot but shows nothing — hidden rather than removed, so
        // every row's name starts at the same x.
        style: row.hasChildren ? CARET_STYLE : { ...CARET_STYLE, visibility: 'hidden' },
        onClick: (event) => {
          event.stopPropagation()
          if (row.hasChildren) onToggleFold(row.key)
        },
      }, react.createElement('span', {
        key: 'glyph',
        className: 'rc-chevron',
        style: collapsed ? CHEVRON_FOLDED_STYLE : CHEVRON_STYLE,
      }))
      // One guide per ancestor, drawn as a hairline: indentation says "nested",
      // a line says "*under that one*".
      const guides = []
      for (let level = 0; level < row.depth; level += 1) {
        guides.push(react.createElement('span', {
          key: `g${level}`, className: 'rc-tree-guide', style: GUIDE_STYLE,
        }))
      }
      const indent = { paddingLeft: '6px' }
      // The gutter is the fold target: `guides + caret` is the strip the eye and the
      // cursor already treat as "the tree's spine", and aiming at an 18px chevron in
      // a long list is a losing game. It stays a real <button> inside for the
      // keyboard, and the caret stops propagation so one click folds once.
      const gutter = react.createElement('span', {
        key: 'gutter',
        className: 'rc-tree-gutter',
        title: row.hasChildren ? (collapsed ? '展开' : '折叠') : '',
        style: row.hasChildren
          ? { display: 'flex', flex: 'none', alignSelf: 'stretch', alignItems: 'center', cursor: 'pointer' }
          : { display: 'flex', flex: 'none', alignSelf: 'stretch', alignItems: 'center' },
        onClick: row.hasChildren
          ? (event) => {
            event.stopPropagation()
            onToggleFold(row.key)
          }
          : undefined,
      }, [...guides, caret])
      if (row.kind === 'group') {
        return react.createElement('div', {
          className: 'rc-tree-group', 'data-key': row.key, style: indent,
          onClick: () => {
            if (row.hasChildren) onToggleFold(row.key)
          },
        }, [
          gutter,
          react.createElement('span', {
            key: 'label',
            className: 'rc-tree-group-label',
            style: { cursor: row.hasChildren ? 'pointer' : 'default' },
          }, row.label),
          row.childCount > 0 ? react.createElement('span', {
            key: 'total', className: 'rc-tree-total',
          }, String(row.childCount)) : null,
          hidden > 0 ? react.createElement('span', { key: 'count', className: 'rc-tree-count' }, `+${hidden}`) : null,
          covers ? react.createElement('span', {
            key: 'covers', className: 'rc-tree-covers', title: '当前目标在这一支下面',
          }, '← 当前') : null,
        ].filter((node) => node !== null))
      }
      const classes = ['rc-tree-row']
      if (active) classes.push('active')
      if (row.subagent) classes.push('dim')
      // A div with `role="button"`, not a `<button>`: the fold caret inside it is a
      // real button, and a button may not contain one. React's DOM API would let it
      // through, but the HTML parser rips the row apart (exactly what the static UI
      // preview did) and a nested button is unusable for a keyboard or a screen
      // reader.
      return react.createElement('div', {
        role: 'button',
        tabIndex: selectable ? 0 : -1,
        'aria-disabled': selectable ? undefined : true,
        className: classes.join(' '),
        title: row.id,
        'data-key': row.key,
        style: indent,
        onClick: selectable ? onClick : undefined,
        onKeyDown: (event) => {
          if (selectable && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault()
            onClick()
          }
        },
      }, [
        gutter,
        react.createElement('span', { key: 'name', className: 'rc-tree-name' }, row.label),
        hidden > 0
          ? react.createElement('span', { key: 'count', className: 'rc-tree-count' }, `+${hidden}`)
          : null,
        covers ? react.createElement('span', {
          key: 'covers', className: 'rc-tree-covers', title: '当前目标在这一支下面',
        }, '← 当前') : null,
        react.createElement('span', { key: 'marks', className: 'rc-tree-marks' }, row.marks),
      ].filter((node) => node !== null))
    }

    // ------------------------------------------------------------------- tabs
    /**
     * One mode's own form.
     *
     * The fields are declared by whoever wrote the mode in the profile, so this
     * renders whatever it is given: a persona mode gets a text box, a picker mode
     * gets a select. A change is written as the whole `modeData` JSON blob, since
     * the settings schema cannot describe a per-mode form.
     */
    function ModeTab(props) {
      const { mode, value, writable, set, active } = props
      const [draft, setDraft] = react.useState({})
      const all = parseJson(value.modeData, {})
      const stored = all[mode.name] === undefined || all[mode.name] === null ? {} : all[mode.name]
      const read = (field) => {
        if (draft[field.key] !== undefined) return draft[field.key]
        if (stored[field.key] !== undefined) return stored[field.key]
        return field.default === undefined ? (field.type === 'bool' ? false : '') : field.default
      }
      /** Commit one field: drop the draft and write the blob once. */
      const commit = (field, next) => {
        setDraft({})
        const nextStored = { ...stored }
        if (next === '' || next === undefined) delete nextStored[field.key]
        else nextStored[field.key] = next
        set('modeData', JSON.stringify({ ...all, [mode.name]: nextStored }))
      }
      const disabled = !writable
      const fields = Array.isArray(mode.fields) ? mode.fields : []
      const body = [
        react.createElement(SectionLabel, {
          key: 'h',
          text: `${mode.label || mode.name}${mode.name === active ? '（当前）' : ''}`,
        }),
      ]
      if (typeof mode.description === 'string' && mode.description !== '') {
        body.push(react.createElement(Note, { key: 'd', text: mode.description }))
      }
      if (fields.length === 0) {
        body.push(react.createElement(Note, {
          key: 'empty',
          text: '此模式暂无配置项。',
        }))
      }
      const rows = []
      for (const field of fields) {
        if (field.type === 'bool') {
          rows.push(react.createElement(Row, {
            key: field.key,
            label: field.label,
            hint: field.help,
            checked: read(field) === true,
            disabled,
            onToggle: (on) => commit(field, on),
          }))
          continue
        }
        let control
        if (field.type === 'select') {
          control = react.createElement('select', {
            className: 'rc-select',
            value: String(read(field)),
            disabled,
            onChange: (event) => commit(field, event.target.value),
          }, (field.options || []).map((option) =>
            react.createElement('option', { key: option, value: option }, option)))
        } else if (field.type === 'text') {
          control = react.createElement('textarea', {
            className: 'rc-textarea',
            rows: field.rows || 4,
            placeholder: field.placeholder,
            value: String(read(field)),
            disabled,
            onChange: (event) => setDraft({ ...draft, [field.key]: event.target.value }),
            onBlur: (event) => commit(field, event.target.value),
          })
        } else {
          control = react.createElement('input', {
            className: 'rc-input',
            type: field.type === 'number' ? 'number' : 'text',
            placeholder: field.placeholder,
            value: String(read(field)),
            disabled,
            onChange: (event) => setDraft({ ...draft, [field.key]: event.target.value }),
            onBlur: (event) => commit(field, field.type === 'number' ? Number(event.target.value) : event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                commit(field, field.type === 'number' ? Number(event.target.value) : event.target.value)
              }
            },
          })
        }
        // A textarea wants the full width, so it gets its own block instead of the
        // right-aligned slot the one-line controls use.
        rows.push(field.type === 'text'
          ? react.createElement(Field, { key: field.key, label: field.label, help: field.help }, control)
          : react.createElement('div', { key: field.key, className: 'rc-field' }, [
            react.createElement('div', { key: 'top', className: 'rc-field-top' }, [
              react.createElement('span', { key: 'l', className: 'rc-field-label' }, field.label),
              react.createElement('span', { key: 'v', className: 'rc-field-value' }, control),
            ]),
            field.help === '' || field.help === undefined ? null : react.createElement('div', {
              key: 'h', className: 'rc-help',
            }, field.help),
          ]))
      }
      if (rows.length > 0) body.push(react.createElement('div', { key: 'form', className: 'rc-card' }, rows))
      if (mode.hasPrompt === true) {
        body.push(react.createElement(Note, {
          key: 'prompt',
          text: '会注入系统提示词，下条消息生效。',
        }))
      }
      return react.createElement('div', null, body)
    }

    /** The 「通用」 tab: identity (with the crop flow), switches, formats, password. */
    function GeneralTab(props) {
      const { value, writable, set, avatar, onRequestCrop, onClearAvatar, active } = props
      const uploaded = typeof value.avatarData === 'string' && value.avatarData.startsWith('data:image/')
      const body = [react.createElement(SectionLabel, { key: 'id', text: '身份' })]
      body.push(react.createElement('div', { key: 'me', className: 'rc-card' }, [
        react.createElement(Field, {
          key: 'avatar',
          label: '头像',
          help: '选择后可裁剪。',
        }, [
          react.createElement('img', {
            key: 'img', className: 'rc-swatch', src: avatar, alt: '',
          }),
          react.createElement('label', { key: 'pick', className: 'rc-btn' }, [
            '选择图片',
            react.createElement('input', {
              key: 'f',
              type: 'file',
              accept: 'image/*',
              disabled: !writable,
              onChange: (event) => {
                const file = event.target.files && event.target.files[0]
                event.target.value = ''
                if (file) onRequestCrop(file)
              },
              style: { display: 'none' },
            }),
          ]),
          uploaded
            ? react.createElement('button', {
              key: 'clear',
              type: 'button',
              className: 'rc-btn',
              disabled: !writable,
              onClick: onClearAvatar,
            }, '移除')
            : null,
        ].filter((node) => node !== null)),
        react.createElement(TextRow, {
          key: 'nickname', label: '昵称', hint: '卡片页脚', value: value.nickname, disabled: !writable,
          onWrite: (next) => set('nickname', next),
        }),
        react.createElement(TextRow, {
          key: 'signature', label: '签名', hint: '卡片页脚', value: value.signature, disabled: !writable,
          onWrite: (next) => set('signature', next),
        }),
      ]))
      body.push(react.createElement(SectionLabel, { key: 'ch', text: '通道' }))
      body.push(react.createElement('div', { key: 'chans', className: 'rc-card' }, [
        react.createElement(Row, {
          key: 'enabled', label: '总开关', hint: value.enabled === false ? '已关闭' : '开',
          checked: value.enabled !== false, disabled: !writable, onToggle: (on) => set('enabled', on),
        }),
        react.createElement(Row, {
          key: 'wechat', label: '微信 · 文件传输助手', hint: '需微信在运行',
          checked: value.wechat === true, disabled: !writable, onToggle: (on) => set('wechat', on),
        }),
        react.createElement(Row, {
          key: 'qq', label: 'QQ · OneBot（NapCat）', hint: '需 NapCat 在运行',
          checked: value.qq === true, disabled: !writable, onToggle: (on) => set('qq', on),
        }),
      ]))
      body.push(react.createElement(SectionLabel, { key: 'fmt', text: '回复与投递' }))
      body.push(react.createElement('div', { key: 'fmts', className: 'rc-card' }, [
        react.createElement(Row, {
          key: 'img',
          label: '图片回复',
          hint: value.imageReplies === false ? '文字' : '图片',
          checked: value.imageReplies !== false,
          disabled: !writable,
          onToggle: (on) => set('imageReplies', on),
        }),
        react.createElement(Row, {
          key: 'steer',
          label: '投递方式',
          hint: value.deliverMode === 'steer' ? '插入' : '排队',
          checked: value.deliverMode === 'steer',
          disabled: !writable,
          onToggle: (on) => set('deliverMode', on ? 'steer' : 'queue'),
        }),
      ]))
      body.push(react.createElement(Note, {
        key: 'fmtnote',
        text: `当前模式「${active.label || active.name}」可能覆盖这两项。`,
      }))
      body.push(react.createElement(SectionLabel, { key: 'sec', text: '管理员密码' }))
      body.push(react.createElement('div', { key: 'secret', className: 'rc-card' }, [
        react.createElement(SecretRow, {
          key: 'pw', label: '管理员密码', hint: '#perm f 使用', disabled: !writable,
          onWrite: (secret) => set('fullAccessPassword', secret),
        }),
      ]))
      body.push(react.createElement(Note, {
        key: 'secnote',
        text: '普通指令免密；密码只写不可读。',
      }))
      return react.createElement('div', null, body)
    }

    /**
     * The 「会话树」 tab: one foldable workspace tree; forks and subagents are
     * already nested below their parent, so rendering the same sessions again as
     * a second lineage tree only duplicates a large list and its interactions.
     *
     * The fold state is owned by the *page* (`props.collapsed`), because leaving the
     * tab unmounts this component: kept here, every fold would be forgotten the
     * moment the operator glanced at another tab and came back.
     */
    function TreeTab(props) {
      const { trees, pinId, writable, set, collapsed, onToggleFold } = props
      const folded = new Set(collapsed)
      const everyKey = trees.grouped
        .filter((row) => row.hasChildren)
        .map((row) => row.key)
      const allFolded = everyKey.length > 0 && everyKey.every((key) => folded.has(key))
      const renderRows = (rows) => {
        const facts = foldFacts(rows, folded, pinId)
        return visibleRows(rows, folded).map((row) => react.createElement(TreeRow, {
          key: row.key,
          row,
          active: row.id === pinId,
          collapsed: folded.has(row.key),
          hidden: facts.get(row.key)?.hidden ?? 0,
          covers: facts.get(row.key)?.covers ?? false,
          onToggleFold,
          onClick: writable && row.subagent !== true ? () => set('pinSessionId', row.id) : undefined,
        }))
      }
      const out = []
      out.push(reactElementHint('点会话切换目标；点箭头折叠。灰色子代理不可选。'))
      out.push(react.createElement('div', { key: 'tools', className: 'rc-tree-tools' }, [
        react.createElement('button', {
          key: 'all',
          type: 'button',
          className: 'rc-btn',
          disabled: everyKey.length === 0,
          onClick: () => onToggleFold(null, allFolded ? [] : everyKey),
        }, allFolded ? '全部展开' : '全部折叠'),
      ]))
      out.push(react.createElement(SectionLabel, { key: 'g', text: '工作区 / 分支 → 会话' }))
      if (trees.grouped.length === 0) out.push(reactElementHint('还没有可显示的会话。'))
      out.push(...renderRows(trees.grouped))
      out.push(react.createElement('div', { key: 'unpin', className: 'rc-actions' },
        react.createElement('button', {
          type: 'button',
          className: 'rc-btn',
          disabled: !writable,
          onClick: () => set('pinSessionId', ''),
        }, '取消锁定')))
      return react.createElement('div', null, out)
    }

    /** A note rendered from a plain string, for callers that have no element yet. */
    function reactElementHint(text) {
      return react.createElement(Note, { text })
    }

    // -------------------------------------------------------------- the plugin
    /**
     * The plugin's front door: an avatar chip at the right end of the session
     * header, the popover it opens, and the configuration page behind it.
     */
    function RemoteChannelChip(props) {
      const scope = props.scope
      const [open, setOpen] = react.useState(false)
      const [page, setPage] = react.useState(false)
      const snapshot = react.useSyncExternalStore(
        (listener) => scope.subscribe(listener),
        () => scope.getSnapshot(),
      )
      if (snapshot.status === 'unavailable') return null
      const value = snapshot.value ?? {}
      const writable = snapshot.writable === true && snapshot.status === 'ready'
      const set = (field, next) => {
        const answer = scope.set(field, next)
        if (answer !== undefined && typeof answer.catch === 'function') answer.catch(() => undefined)
      }
      const uploaded = typeof value.avatarData === 'string' && value.avatarData.startsWith('data:image/')
      const avatar = uploaded ? value.avatarData : DEFAULT_AVATAR
      const modes = String(value.modes ?? 'default').split(',').map((name) => name.trim()).filter(Boolean)
      const active = String(value.mode ?? 'default')
      const on = value.enabled !== false
      const ready = on && (value.wechat === true || value.qq === true)

      if (page) {
        return react.createElement(ConfigPage, {
          scope,
          avatar,
          writable,
          value,
          set,
          onClose: () => setPage(false),
          useSessions: props.useSessions,
          useWorkspaces: props.useWorkspaces,
        })
      }

      const button = react.createElement('button', {
        key: 'chip',
        type: 'button',
        className: `rc-chip${on ? '' : ' off'}`,
        title: `${value.nickname || '远程通道'} · ${ready ? '通道就绪' : (on ? '等待通道' : '已关闭')} · 点开配置`,
        onClick: () => setOpen(!open),
      }, [
        react.createElement('img', { key: 'a', className: 'rc-chip-avatar', src: avatar, alt: '' }),
        react.createElement('span', { key: 'n', className: 'rc-chip-name' }, value.nickname || '远程'),
        react.createElement('span', {
          key: 'd', className: `rc-dot${ready ? '' : ' dim'}`,
        }),
      ])

      if (!open) return button

      const rows = []
      rows.push(react.createElement('div', { key: 'who', className: 'rc-pop-head' }, [
        react.createElement('img', {
          key: 'img', className: `rc-avatar${on ? ' ring' : ''}`, src: avatar, alt: '',
          style: { width: '42px', height: '42px' },
        }),
        react.createElement('div', { key: 'meta', style: { minWidth: 0 } }, [
          react.createElement('div', { key: 'n', className: 'rc-title' }, value.nickname || '未设昵称'),
          react.createElement('div', { key: 's', className: 'rc-sub' }, value.signature || '未设签名'),
        ]),
      ]))
      rows.push(react.createElement('button', {
        key: 'page',
        type: 'button',
        className: 'rc-btn primary wide',
        onClick: () => {
          setOpen(false)
          setPage(true)
        },
      }, '打开配置页'))
      rows.push(react.createElement('div', { key: 'switches' }, [
        react.createElement(Row, {
          key: 'enabled', label: '总开关', hint: on ? '开' : '已关闭',
          checked: on, disabled: !writable, onToggle: (next) => set('enabled', next),
        }),
        react.createElement(Row, {
          key: 'wechat', label: '微信 · 文件传输助手', hint: '需微信在运行',
          checked: value.wechat === true, disabled: !writable, onToggle: (next) => set('wechat', next),
        }),
        react.createElement(Row, {
          key: 'qq', label: 'QQ · OneBot（NapCat）', hint: '需 NapCat 在运行',
          checked: value.qq === true, disabled: !writable, onToggle: (next) => set('qq', next),
        }),
      ]))
      rows.push(react.createElement('div', { key: 'modes', className: 'rc-modes' }, [
        react.createElement('span', { key: 'l', className: 'rc-hint' }, '模式'),
        ...modes.map((name) => react.createElement('button', {
          key: name,
          type: 'button',
          disabled: !writable,
          title: '切换工作模式',
          className: `rc-pill${name === active ? ' active' : ''}`,
          onClick: () => set('mode', name),
        }, name)),
      ]))
      rows.push(react.createElement('div', { key: 'target', className: 'rc-foot' },
        `目标：${value.pinLabel || '自动'}${value.speakerLabel ? ` · 最近：${value.speakerLabel}` : ''}`))

      return react.createElement('div', { key: 'wrap', style: { position: 'relative' } }, [
        button,
        react.createElement('div', { key: 'panel', className: 'rc-pop' }, [
          rows[0],
          rows[1],
          react.createElement('div', { key: 'body' }, rows.slice(2)),
        ]),
      ])
    }

    /**
     * The configuration page: a full-screen sheet with one tab per subject.
     *
     * It is a page rather than a settings section on purpose — the operator asked
     * for it behind the avatar, and a mode author's own fields (a persona box, a
     * picker) can be rendered here without touching the Host's settings schema.
     * It also owns the avatar crop dialog, because that flow spans two steps.
     */
    function ConfigPage(props) {
      const { scope, value, writable, set, avatar, onClose } = props
      const useSessions = typeof props.useSessions === 'function' ? props.useSessions : NO_STORE
      const useWorkspaces = typeof props.useWorkspaces === 'function' ? props.useWorkspaces : NO_STORE
      const sessions = useSessions((state) => state) || EMPTY_SESSIONS
      const workspaceState = useWorkspaces((state) => state) || {}
      const modeSchema = parseJson(value.modeSchema, [])
      const [tab, setTab] = react.useState('general')
      const [crop, setCrop] = react.useState(null)
      // Here rather than inside `TreeTab`: a tab switch unmounts that component, and
      // folding is not something the operator expects to lose by looking elsewhere.
      const [collapsed, setCollapsed] = react.useState([])
      const onToggleFold = (key, replace = null) => setCollapsed((current) => {
        if (replace !== null) return replace
        return current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key]
      })
      const tabs = [
        { key: 'general', label: '通用' },
        { key: 'tree', label: '会话树' },
        ...modeSchema.map((mode) => ({ key: `mode:${mode.name}`, label: mode.label || mode.name })),
      ]
      const activeMode = modeSchema.find((mode) => mode.name === String(value.mode ?? 'default'))
        ?? { name: 'default', label: '工作', description: '', fields: [] }
      const pinId = typeof value.pinSessionId === 'string' ? value.pinSessionId : ''
      const trees = treeRows(sessions, workspaceState.items, pinId, workspaceState.archivedSessionIds)

      let body
      if (tab === 'tree') {
        body = react.createElement(TreeTab, { trees, pinId, writable, set, collapsed, onToggleFold })
      } else if (tab.indexOf('mode:') === 0) {
        const mode = modeSchema.find((entry) => `mode:${entry.name}` === tab)
        body = mode === undefined
          ? reactElementHint('这个模式已经不存在了（profile 里删掉了？）。')
          : react.createElement(ModeTab, { mode, value, writable, set, active: activeMode.name })
      } else {
        body = react.createElement(GeneralTab, {
          value,
          writable,
          set,
          avatar,
          active: activeMode,
          onClearAvatar: () => set('avatarData', ''),
          onRequestCrop: (file) => readImageFile(file, (picked) => setCrop(picked)),
        })
      }

      const sheet = react.createElement('div', { className: 'rc-sheet' }, [
        react.createElement('div', { key: 'head', className: 'rc-sheet-head' }, [
          react.createElement('img', {
            key: 'a', className: 'rc-avatar ring', src: avatar, alt: '',
            style: { width: '40px', height: '40px' },
          }),
          react.createElement('div', { key: 'who', style: { minWidth: 0 } }, [
            react.createElement('div', { key: 'n', className: 'rc-title' }, value.nickname || '远程通道'),
            react.createElement('div', { key: 's', className: 'rc-sub' }, value.signature || '未设签名'),
          ]),
          react.createElement('button', {
            key: 'close', type: 'button', className: 'rc-btn', onClick: onClose,
            style: { marginLeft: 'auto' },
          }, '关闭'),
        ]),
        react.createElement('div', { key: 'tabs', className: 'rc-tabs' }, tabs.map((entry) =>
          react.createElement('button', {
            key: entry.key,
            type: 'button',
            className: `rc-pill${entry.key === tab ? ' active' : ''}`,
            onClick: () => setTab(entry.key),
          }, entry.label))),
        react.createElement('div', { key: 'body', className: 'rc-body' }, body),
      ])

      return react.createElement('div', {
        key: 'overlay',
        className: 'rc-overlay',
        onClick: (event) => {
          if (event.target === event.currentTarget && crop === null) onClose()
        },
      }, crop === null ? sheet : react.createElement('div', { className: 'rc-sheet' }, [
        react.createElement('div', { key: 'head', className: 'rc-sheet-head' }, [
          react.createElement('span', { key: 't', className: 'rc-title' }, '选择头像区域'),
        ]),
        react.createElement(CropDialog, {
          key: 'crop',
          image: crop.el,
          src: crop.src,
          width: crop.width,
          height: crop.height,
          disabled: !writable,
          onCancel: () => setCrop(null),
          onDone: (dataUrl) => {
            setCrop(null)
            set('avatarData', dataUrl)
          },
        }),
      ]))
    }

    /**
     * The plugin's card in Settings → 插件: the same switches, in the secondary
     * entrance, so a deployment without a session header still has a control.
     */
    function RemoteChannelCard(props) {
      const scope = props.scope
      const [open, setOpen] = react.useState(true)
      const snapshot = react.useSyncExternalStore(
        (listener) => scope.subscribe(listener),
        () => scope.getSnapshot(),
      )
      if (snapshot.status === 'unavailable') return null

      const value = snapshot.value ?? {}
      const writable = snapshot.writable === true && snapshot.status === 'ready'
      const masterOff = value.enabled === false
      const set = (field, on) => {
        const answer = scope.set(field, on)
        if (answer !== undefined && typeof answer.catch === 'function') answer.catch(() => undefined)
      }
      const summary = `总开关 ${onOff(value.enabled)} · 微信 ${onOff(value.wechat)} · QQ ${onOff(value.qq)}`
      const header = react.createElement('button', {
        key: 'head',
        type: 'button',
        className: 'rc-row',
        onClick: () => setOpen(!open),
      }, [
        react.createElement('span', { key: 'arrow', className: 'rc-hint', style: { marginLeft: 0 } }, open ? '▾' : '▸'),
        react.createElement('span', { key: 'title', className: 'rc-row-label' }, '远程通道'),
        react.createElement('span', { key: 'sum', className: 'rc-hint' }, summary),
      ])

      if (!open) {
        return react.createElement('div', {
          style: { border: `1px solid ${BORDER}`, borderRadius: '12px', overflow: 'hidden' },
        }, [header])
      }

      const note = snapshot.status === 'loading'
        ? '读取中…'
        : (writable ? null : '设置只读，请用聊天指令修改。')
      const body = [header]
      if (note !== null) {
        body.push(react.createElement('div', {
          key: 'note', className: 'rc-help', style: { padding: '0 12px 8px 32px' },
        }, note))
      }
      body.push(
        react.createElement(Row, {
          key: 'enabled',
          label: '总开关',
          hint: masterOff ? '已关闭' : '开',
          checked: !masterOff,
          disabled: !writable,
          onToggle: (on) => set('enabled', on),
        }),
        react.createElement(Row, {
          key: 'wechat',
          label: '微信 · 文件传输助手',
          hint: '需微信在运行',
          checked: value.wechat !== false,
          disabled: !writable,
          dimmed: masterOff,
          onToggle: (on) => set('wechat', on),
        }),
        react.createElement(Row, {
          key: 'qq',
          label: 'QQ · OneBot（NapCat）',
          hint: '需 NapCat 在运行',
          checked: value.qq !== false,
          disabled: !writable,
          dimmed: masterOff,
          onToggle: (on) => set('qq', on),
        }),
        react.createElement(SecretRow, {
          key: 'fullAccessPassword',
          label: '管理员密码',
          hint: '#perm f 使用',
          disabled: !writable,
          onWrite: (secret) => set('fullAccessPassword', secret),
        }),
      )
      body.push(react.createElement('div', { key: 'auth-hint', className: 'rc-help', style: { padding: '8px 12px' } },
        '普通指令免密；密码只写不可读。'))
      if (masterOff) {
        body.push(react.createElement('div', { key: 'off', className: 'rc-help', style: { padding: '8px 12px' } },
          '总开关已关闭：不转发、不汇报、不通知。'))
      }

      return react.createElement('div', {
        style: { border: `1px solid ${BORDER}`, borderRadius: '12px', overflow: 'hidden' },
      }, body)
    }

    /**
     * Mount everything: the stylesheet, the Settings card, and the header chip.
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      const styleReport = ensureStyles()
      const scope = ctx.settingsScope.bind({ namespace: NS })
      // "The UI looks different from the preview" has to be answerable from the
      // host's side, because that is where I can read a log. This records what the
      // *document* ended up with on every load/hot reload: which revision, whether
      // the tag had to be refreshed, and when.
      try {
        const answer = scope.set('uiProbe', `${styleReport} css=${STYLES.length} @${new Date().toISOString()}`)
        if (answer !== undefined && typeof answer.catch === 'function') answer.catch(() => undefined)
      } catch {
        // A read-only deployment simply does not get the probe; nothing depends on it.
      }
      ctx.slots.inject('settings.plugin.item', function* () {
        yield ctx.slots.register({
          name: 'settings.plugin.item',
          key: NS,
          inject: () => ({ scope }),
        }, RemoteChannelCard)
      })
      // The front door: an avatar chip in the session header's right-aligned
      // utilities row, where 「本地打开」 lives. `order: 1000` puts it last, i.e.
      // at the far right of that row, whatever other plugins register.
      ctx.slots.inject('conversation.session.header.utilities', function* () {
        yield ctx.slots.register({
          name: 'conversation.session.header.utilities',
          id: 'remote-channel-profile',
          order: 1000,
          inject: () => ({ scope }),
        }, RemoteChannelChip)
      })
    }

    exports.name = 'remote-channel-settings'
    exports.inject = ['slots', 'settingsScope']
    exports.apply = apply
    /**
     * Pure helpers plus one component, exported for the offline tools only:
     * `tools/client-half-check.mjs` checks the crop maths and the tree builder
     * (neither needs a DOM), and `tools/ui-preview.mjs` renders `CropDialog`
     * directly, because that dialog only mounts after a real file pick. The module
     * loader ignores every export except `name` / `inject` / `apply`.
     */
    exports.__ui = { cropSourceRect, clampPan, treeRows, relativeTime, parseJson, CropDialog }
    return module.exports
  },
})
