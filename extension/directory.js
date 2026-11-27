export function isDirectory(url) {
  try { const u = new URL(url); return /^https?:$/.test(u.protocol) && u.pathname.endsWith('/') && !u.search && !u.hash; } catch { return false; }
}
export function isIndex(title) { return /^Index of\s+\//i.test(String(title || '').trim()); }
export function parts(root, url) {
  const r = new URL(root), u = new URL(url);
  if (!isDirectory(root) || u.origin !== r.origin || u.username || u.password || u.search || u.hash || !u.pathname.startsWith(r.pathname)) throw Error('Outside selected directory');
  const tail = u.pathname.slice(r.pathname.length).replace(/\/$/, '');
  const result = tail.split('/').map(decodeURIComponent);
  if (result.some(x => !x || x === '.' || x === '..' || /[\\/\u0000-\u001f]/.test(x)) || result.length > 33) throw Error('Unsafe path');
  return result;
}
export function child(root, url) {
  try { return parts(root,url).length === 1; } catch { return false; }
}
export async function scan(root) {
  const visited = new Set(), files = [];
  async function walk(url, depth) {
    if (visited.has(url)) return;
    if (depth > 32 || visited.size >= 250) throw Error('Directory scan limit exceeded');
    visited.add(url);
    const response = await fetch(url,{redirect:'error',credentials:'omit',signal:AbortSignal.timeout(30000)});
    if (!response.ok || !/text\/html/i.test(response.headers.get('content-type') || '')) throw Error('Cannot read '+url);
    const doc = new DOMParser().parseFromString(await response.text(),'text/html');
    if (!isIndex(doc.title) && !isIndex(doc.querySelector('h1')?.textContent)) throw Error('Not an Apache directory index: '+url);
    const seen = new Set();
    for (const a of doc.querySelectorAll('a[href]')) {
      const target = new URL(a.getAttribute('href'),url).href;
      if (!child(url,target) || seen.has(target)) continue;
      seen.add(target);
      if (isDirectory(target)) await walk(target,depth+1);
      else {
        if (files.length >= 250) throw Error('Batch exceeds 250 files');
        files.push({url:target,filename:parts(root,target).at(-1),rootUrl:root,sourcePageUrl:url,sourcePageTitle:doc.title,text:a.textContent.trim(),context:(a.closest('tr') || a.parentElement)?.textContent.trim().slice(0,1500) || ''});
      }
    }
  }
  await walk(root,0);
  return {files, directories:visited.size};
}
