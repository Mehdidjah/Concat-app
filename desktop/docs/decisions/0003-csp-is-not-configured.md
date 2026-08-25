# 0003 - Content Security Policy: OPEN QUESTION

`"csp": null` in `tauri.conf.json`, which disables the policy entirely.

That is defensible right now - the app loads only its own bundled assets - and
indefensible the moment it renders anything it did not author: a thumbnail from
a downloaded file, a project template, an update notice, a plugin's UI.

A starting point when that day comes:

```json
"csp": "default-src 'self'; img-src 'self' asset: http://asset.localhost blob: data:; media-src 'self' asset: http://asset.localhost blob:; style-src 'self' 'unsafe-inline'; script-src 'self'"
```

Two things to check when enabling it:

- Vite's dev server and React Fast Refresh inject inline scripts. Confirm
  `npm run app` still hot-reloads, or scope the policy to release builds.
- Tailwind v4 emits a real stylesheet rather than inline styles, but component
  `style={{...}}` attributes still need `'unsafe-inline'` under `style-src`.

Delete this file once a policy is in place.
