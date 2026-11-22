import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Serves the `library` folder beside the app (your ripped models, maps and animations) to the app, so it can offer
 * them in drop-downs. The folder is read from this computer only and is never part of the repository.
 */
function libraryPlugin() {
  const root = path.resolve('library');
  fs.mkdirSync(root, { recursive: true });
  const walk = (dir, out = []) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      if (stat.isDirectory()) walk(full, out);
      else out.push({ path: path.relative(root, full).split(path.sep).join('/'), size: stat.size });
    }
    return out;
  };
  const handler = (req, res) => {
    let url;
    try { url = decodeURIComponent((req.url || '/').split('?')[0]); } catch { res.statusCode = 400; res.end(); return; }
    if (url === '/index.json') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({ files: walk(root) }));
      return;
    }
    const file = path.resolve(root, '.' + url);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; res.end('Not found'); return; }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', fs.statSync(file).size);
    fs.createReadStream(file).pipe(res);
  };
  return {
    name: 'cinematic-library',
    configureServer(server) { server.middlewares.use('/library', handler); },
    configurePreviewServer(server) { server.middlewares.use('/library', handler); },
  };
}

export default defineConfig({ plugins: [libraryPlugin()], server: { host: '127.0.0.1', port: 5173 }, build: { target: 'es2022' } });
