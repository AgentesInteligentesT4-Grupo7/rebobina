import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { AudioLeveler } from '../extensao/AudioLeveler.js';
import { MediaLibrary } from '../extensao/MediaLibrary.js';

function workspaceWith(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'biblioteca-'));
  fs.mkdirSync(path.join(dir, 'downloads'));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, 'downloads', name), content);
  return dir;
}

describe('Biblioteca dos downloads', () => {
  it('uma entrada por pedido, na ordem; repetir o mesmo link atualiza; cada dono vê só as suas', () => {
    const dir = workspaceWith({ 'Faixa A.mp3': 'a', 'Faixa B.mp3': 'b' });
    const library = new MediaLibrary(dir);
    const files = ['Faixa B.mp3', 'Faixa A.mp3'].map((f) => path.join(dir, 'downloads', f));
    const first = library.add('ana', { titulo: 'Minha playlist', url: 'https://youtu.be/p', formato: 'mp3', arquivos: files })!;
    library.add('ana', { titulo: 'Minha playlist', url: 'https://youtu.be/p', formato: 'mp3', arquivos: files });
    library.add('beto', { titulo: 'Do Beto', url: 'https://youtu.be/b', formato: 'mp3', arquivos: [files[0]!] });

    const ana = library.list('ana');
    assert.equal(ana.length, 1, 'o mesmo link no mesmo formato não repete');
    assert.equal(ana[0]!.id, first.id);
    assert.deepEqual(ana[0]!.faixas.map((t) => t.nome), ['Faixa B', 'Faixa A'], 'na ordem da playlist');
    assert.deepEqual(library.list('beto').map((e) => e.titulo), ['Do Beto']);
    assert.match(first.id, /^[0-9a-f]{24}$/);

    // Sobrevive a reiniciar; arquivo apagado some da lista; tirar da biblioteca não apaga o arquivo.
    fs.unlinkSync(files[1]!);
    const reloaded = new MediaLibrary(dir);
    assert.deepEqual(reloaded.list('ana')[0]!.faixas.map((t) => t.nome), ['Faixa B']);
    assert.equal(reloaded.track(first.id, 0)!.nome, 'Faixa B.mp3');
    assert.equal(reloaded.track(first.id, 1), undefined);
    assert.equal(reloaded.remove('beto', first.id), false, 'só o dono tira');
    assert.equal(reloaded.remove('ana', first.id), true);
    assert.deepEqual(reloaded.list('ana'), []);
    assert.ok(fs.existsSync(files[0]!));
  });
});

/** Serviço de mentira: "nivela" devolvendo "NIVELADO:" + conteúdo, com os volumes nos cabeçalhos. */
function fakeService(): http.Server {
  return http.createServer((req, res) => {
    const name = new URL(req.url!, 'http://x').searchParams.get('nome') ?? '';
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (!/\.(mp3|mp4)$/.test(name)) return void res.writeHead(415, { 'content-type': 'application/json' }).end(JSON.stringify({ detail: 'formato não suportado' }));
      const url = new URL(req.url!, 'http://x');
      if (url.pathname === '/medir') return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ lufs: -9, pico: 1.4, alvo: -14, ganho: -5 }));
      const renamed = url.searchParams.get('padronizar') === '1' ? { 'x-nome': encodeURIComponent('Faixa - Artista.mp3') } : {};
      res.writeHead(200, { 'x-volume-antes': '-23.9', 'x-volume-depois': '-14.0', ...renamed }).end(Buffer.concat([Buffer.from('NIVELADO:'), ...chunks]));
    });
  });
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('Nivelamento de volume', () => {
  const service = fakeService();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nivelar-'));
  let serviceUrl = '';
  before(async () => (serviceUrl = await listen(service)));
  after(() => service.close());

  it('arquivo no servidor é trocado pela versão nivelada (sem ficar pela metade); formato não suportado avisa', async () => {
    const leveler = new AudioLeveler({ baseUrl: serviceUrl, timeoutMs: 5_000 });
    const file = path.join(dir, 'musica.mp3');
    fs.writeFileSync(file, 'ID3');
    assert.deepEqual(await leveler.levelFile(file), { before: -23.9, after: -14 });
    assert.equal(fs.readFileSync(file, 'utf8'), 'NIVELADO:ID3');
    assert.ok(!fs.existsSync(`${file}.nivelando`));
    await assert.rejects(leveler.levelStream(Buffer.from('x'), 'nota.txt'), /não dá para nivelar/);
  });
});
