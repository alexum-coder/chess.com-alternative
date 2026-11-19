// Shared header + login session for every page. Load after supabase.js and /config.js.
(function () {
  const cfg = window.ZZ_CONFIG || {};
  const sb = cfg.url && window.supabase ? window.supabase.createClient(cfg.url, cfg.anonKey) : null;
  const ZZ = (window.ZZ = { sb, session: null, account: null });

  const style = document.createElement('style');
  style.textContent = `
  .zznav{width:100%;padding:12px max(18px,calc((100vw - 1180px)/2));display:flex;align-items:center;gap:26px;
    color:#f7f8f6;background:#26332b;box-shadow:0 2px 10px rgba(24,36,27,.15);font:700 14px Manrope,system-ui,-apple-system,"Segoe UI",sans-serif}
  .zznav a{color:inherit;text-decoration:none}
  .zzbrand{font-size:1.22rem;letter-spacing:-.025em;color:#fff}
  .zznav nav{display:flex;gap:18px}
  .zznav nav a{color:#c5d1c7;padding:5px 0;border-bottom:2px solid transparent}
  .zznav nav a[aria-current="page"]{color:#fff;border-color:#9bd36c}
  .zzuser{margin-left:auto;display:flex;align-items:center;gap:10px}
  .zzwho{color:#f7f8f6;text-decoration:none}
  .zzbtn,.zzout{font:inherit;font-size:.9rem;cursor:pointer;border-radius:6px;padding:6px 12px;border:1px solid rgba(255,255,255,.24);
    background:transparent;color:#f7f8f6}
  .zzbtn{background:#81b64c;border-color:#81b64c;color:#172014;font-weight:800}
  .zznav a:focus-visible,.zznav button:focus-visible{outline:2px solid var(--accent,#f2b84b);outline-offset:2px}
  @media (max-width:560px){.zznav{gap:14px;padding:10px 14px}.zznav nav{gap:12px}.zzwho{display:none}.zzbrand{font-size:1.05rem}}`;
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
  for (const [label, href] of [['Play', '/'], ['Tournaments', '/#tournamentPanel'], ['Profile', '/profile.html']]) {
    const a = mk('a', '', label, href);
    if ((href === '/' && (location.pathname === '/' || location.pathname === '/index.html'))
        || (href === '/profile.html' && location.pathname === href)) a.setAttribute('aria-current', 'page');
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
    const accountLabel = ZZ.account?.ratingReady ? ZZ.account.rating : `Provisional ${ZZ.account?.games || 0}/5`;
    const who = mk('a', 'zzwho', ZZ.account ? `${ZZ.account.name} · ${accountLabel}` : 'Account', '/profile.html');
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
