// Shared header + login session for every page. Load after supabase.js and /config.js.
(function () {
  const cfg = window.ZZ_CONFIG || {};
  const sb = cfg.url && window.supabase ? window.supabase.createClient(cfg.url, cfg.anonKey) : null;
  const ZZ = (window.ZZ = { sb, session: null, account: null });

  const style = document.createElement('style');
  style.textContent = `
  .zznav{max-width:980px;margin:0 auto;padding:14px 16px 0;display:flex;align-items:center;gap:22px;
    color:var(--ink,#e9eef3);font:700 15px Manrope,system-ui,-apple-system,"Segoe UI",sans-serif}
  .zznav a{color:inherit;text-decoration:none}
  .zzbrand{font-size:1.25rem;letter-spacing:-.01em}
  .zznav nav{display:flex;gap:18px}
  .zznav nav a{color:var(--muted,#8fa1b3);padding:4px 0;border-bottom:2px solid transparent}
  .zznav nav a[aria-current="page"]{color:var(--ink,#e9eef3);border-color:var(--accent,#f2b84b)}
  .zzuser{margin-left:auto;display:flex;align-items:center;gap:10px}
  .zzwho{color:var(--ink,#e9eef3)}
  .zzbtn,.zzout{font:inherit;font-size:.9rem;cursor:pointer;border-radius:6px;padding:6px 12px;border:1px solid var(--line,#3a4b61);
    background:none;color:var(--ink,#e9eef3)}
  .zzbtn{background:var(--accent,#f2b84b);border-color:var(--accent,#f2b84b);color:#1b2430;font-weight:700}
  .zznav a:focus-visible,.zznav button:focus-visible{outline:2px solid var(--accent,#f2b84b);outline-offset:2px}
  @media (max-width:520px){.zznav{gap:12px}.zzwho{display:none}}`;
  document.head.appendChild(style);

  const header = document.createElement('header');
  header.className = 'zznav';
  const mk = (tag, cls, text, href) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    if (href) e.href = href;
    return e;
  };
  const nav = document.createElement('nav');
  for (const [label, href] of [['Play', '/'], ['Profile', '/profile.html']]) {
    const a = mk('a', '', label, href);
    if (location.pathname === href || (href === '/' && location.pathname === '/index.html')) a.setAttribute('aria-current', 'page');
    nav.appendChild(a);
  }
  const box = mk('div', 'zzuser');
  header.append(mk('a', 'zzbrand', 'Zugzwang', '/'), nav, box);
  document.body.prepend(header);

  let seq = 0;
  async function render(force) {
    const my = ++seq;
    if (!sb) { box.replaceChildren(); return; }
    if (!ZZ.session) { ZZ.account = null; box.replaceChildren(mk('a', 'zzbtn', 'Log in', '/login.html')); return; }
    if (force || ZZ.account?.id !== ZZ.session.user.id) {
      try {
        const r = await fetch('/api/me', { headers: { Authorization: 'Bearer ' + ZZ.session.access_token } });
        ZZ.account = r.ok ? await r.json() : null;
      } catch { ZZ.account = null; }
    }
    if (my !== seq) return;
    const who = mk('a', 'zzwho', ZZ.account ? `${ZZ.account.name} · ${ZZ.account.rating}` : 'Account', '/profile.html');
    const out = mk('button', 'zzout', 'Log out');
    out.type = 'button';
    out.onclick = async () => { await sb.auth.signOut(); location.href = '/'; };
    box.replaceChildren(who, out);
  }

  ZZ.refresh = () => render(true);
  ZZ.ready = sb
    ? sb.auth.getSession().then(({ data }) => { ZZ.session = data.session; return render(); })
    : Promise.resolve();
  if (sb) {
    sb.auth.onAuthStateChange((_ev, s) => {
      ZZ.session = s;
      render();
      window.dispatchEvent(new CustomEvent('zz:auth'));
    });
  } else { render(); }
})();
