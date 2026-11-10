import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { AudioLeveler } from '../extensao/AudioLeveler.js';
import ativar from '../extensao/index.js';
import { MediaDownloader } from '../extensao/MediaDownloader.js';
import { MediaLibrary } from '../extensao/MediaLibrary.js';
import { registrarRotas } from '../extensao/rotas.js';
import { K7Falso, dono } from './k7-falso.js';
import { fakeClient } from './servico-falso.js';

/** Serviço de mentira: "nivela" devolvendo "NIVELADO:" + conteúdo, com os volumes nos cabeçalhos. */
function fakeLeveler(): http.Server {
  return http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    if (url.pathname === '/health') return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ nivelar_paralelo: 3 }));
    const name = url.searchParams.get('nome') ?? '';
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (!/\.(mp3|mp4)$/.test(name)) return void res.writeHead(415, { 'content-type': 'application/json' }).end(JSON.stringify({ detail: 'formato não suportado' }));
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

const ANA = 'visitante-ana-0000000000000001';
const BETO = 'visitante-beto-000000000000002';

describe('Extensão: o que a fita registra no tocador', () => {
  it('ferramentas baixar_youtube e procurar_youtube, rotas em /api/x/ e o painel; o paralelismo vem do serviço', async () => {
    const service = fakeLeveler();
    const url = await listen(service);
    try {
      const k7 = new K7Falso({ workspaceDir: fs.mkdtempSync(path.join(os.tmpdir(), 'rebobina-')) });
      await ativar(k7.api({ YTDLP_BASE_URL: `${url}/` }));
      assert.deepEqual(k7.ferramentas.map((t) => t.name), ['baixar_youtube', 'procurar_youtube']);
      assert.ok(k7.rotas.every((r) => r.caminho.source.startsWith('^\\/api\\/x\\/')));
      assert.deepEqual(k7.painel, { script: 'web/painel.js', estilo: 'web/painel.css', imagens: ['https://i.ytimg.com'], quadros: ['https://www.youtube-nocookie.com'] });
      const base = await k7.ouvir();
      try {
        assert.deepEqual(await (await fetch(`${base}/api/x/info`, { headers: { 'x-visitante': ANA } })).json(), { nivelar: true, nivelarParalelo: 3 });
      } finally {
        await k7.fechar();
      }
    } finally {
      service.close();
    }
  });
});

describe('Rotas do painel: biblioteca, faixas, .zip, nivelar e tentar de novo', () => {
  const service = fakeLeveler();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebobina-rotas-'));
  const library = new MediaLibrary(dir);
  const failing = new Set(['BBBBBBBBBBB']);
  const downloader = new MediaDownloader(fakeClient(failing, []), dir, library);
  const k7 = new K7Falso({ workspaceDir: dir });
  let base = '';

  before(async () => {
    registrarRotas(k7.api(), library, downloader, new AudioLeveler({ baseUrl: await listen(service), timeoutMs: 5_000 }), 2);
    base = await k7.ouvir();
  });
  after(async () => {
    service.close();
    await k7.fechar();
  });

  const get = (route: string, visitor?: string) => fetch(`${base}${route}`, { headers: visitor ? { 'x-visitante': visitor } : {} });
  const post = (route: string, visitor?: string, body?: string) => fetch(`${base}${route}`, { method: 'POST', headers: visitor ? { 'x-visitante': visitor } : {}, ...(body ? { body } : {}) });
  const listFor = async (visitor: string) =>
    (await (await get('/api/x/biblioteca', visitor)).json()) as Array<{ id: string; titulo: string; nivelada: boolean; falhas: unknown[]; faixas: Array<{ nome: string; arquivo: string; url: string }> }>;

  it('cada visitante vê só as suas playlists; a faixa abre pela URL; só o dono tira', async () => {
    fs.mkdirSync(path.join(dir, 'downloads'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'downloads', 'Musica.mp3'), 'ID3-0123456789');
    library.add(dono(ANA), { titulo: 'Da Ana', url: 'https://youtu.be/a', formato: 'mp3', arquivos: [path.join(dir, 'downloads', 'Musica.mp3')] });

    const ana = await listFor(ANA);
    assert.deepEqual(ana.map((e) => [e.titulo, e.faixas.map((t) => t.nome)]), [['Da Ana', ['Musica']]]);
    assert.deepEqual(await listFor(BETO), []);
    assert.match(ana[0]!.faixas[0]!.url, /^\/api\/x\/biblioteca\/[0-9a-f]{24}\/0$/);
    const track = await get(ana[0]!.faixas[0]!.url);
    assert.equal(await track.text(), 'ID3-0123456789', 'sem visitante: <audio> não manda cabeçalho');
    assert.equal((await get(`/api/x/biblioteca/${'0'.repeat(24)}/0`)).status, 404);

    const remove = (visitor: string) => fetch(`${base}/api/x/biblioteca/${ana[0]!.id}`, { method: 'DELETE', headers: { 'x-visitante': visitor } });
    assert.equal((await remove(BETO)).status, 404);
    assert.equal((await remove(ANA)).status, 200);
    assert.deepEqual(await listFor(ANA), []);
  });

  it('a playlist inteira sai num .zip com o nome dela; tentar de novo baixa só os que falharam, só para o dono', async () => {
    await downloader.download({ url: 'https://www.youtube.com/playlist?list=PL1', formato: 'mp3', playlist: true, userId: dono(ANA) });
    const [entry] = await listFor(ANA);
    assert.equal(entry!.falhas.length, 1);
    assert.deepEqual(entry!.faixas.map((t) => t.arquivo), ['AAAAAAAAAAA.mp3', 'CCCCCCCCCCC.mp3']);

    const zip = await get(`/api/x/biblioteca/${entry!.id}/zip`);
    assert.match(zip.headers.get('content-disposition')!, /filename="Playlist de teste\.zip"/);
    assert.equal(await zip.text(), 'PK AAAAAAAAAAA.mp3,CCCCCCCCCCC.mp3');

    const other = await post(`/api/x/biblioteca/${entry!.id}/tentar-de-novo`, BETO);
    assert.equal(((await other.json()) as { ok: boolean }).ok, false, 'só o dono');
    failing.clear();
    const retry = await post(`/api/x/biblioteca/${entry!.id}/tentar-de-novo`, ANA);
    assert.deepEqual(await retry.json(), { ok: true, novos: 1, falhas: [] });
    const [updated] = await listFor(ANA);
    assert.deepEqual([updated!.faixas.length, updated!.falhas.length], [3, 0]);
  });

  it('arquivo da pasta do visitante: vai, volta nivelado (e com o nome padronizado, se pedir); medir só devolve os números', async () => {
    const res = await post(`/api/x/nivelar?nome=${encodeURIComponent('Minha música.mp3')}`, ANA, 'ID3-local');
    assert.equal(res.headers.get('x-volume-antes'), '-23.9');
    assert.equal(await res.text(), 'NIVELADO:ID3-local');
    const bad = await post('/api/x/nivelar?nome=nota.txt', ANA, 'x');
    assert.equal(bad.status, 422);
    assert.match(((await bad.json()) as { erro: string }).erro, /não dá para nivelar/);
    assert.equal((await post('/api/x/nivelar?nome=a.mp3', undefined, 'x')).status, 400, 'sem visitante');
    assert.equal((await post('/api/x/nivelar', ANA, 'x')).status, 400, 'sem nome');

    const both = await post('/api/x/nivelar?nome=a.mp3&padronizar=1', ANA, 'ID3');
    assert.equal(decodeURIComponent(both.headers.get('x-nome')!), 'Faixa - Artista.mp3');
    assert.deepEqual(await (await post('/api/x/medir?nome=a.mp3', ANA, 'ID3')).json(), { lufs: -9, pico: 1.4, alvo: -14, ganho: -5 });
  });

  it('playlist baixada: nivela todas as faixas no servidor e fica marcada; o andamento aparece e some no fim', async () => {
    const [entry] = await listFor(ANA);
    const res = await post(`/api/x/biblioteca/${entry!.id}/nivelar`, ANA);
    assert.deepEqual(await res.json(), { ok: true, niveladas: 3, problemas: [] });
    assert.equal(fs.readFileSync(path.join(dir, 'downloads', 'AAAAAAAAAAA.mp3'), 'utf8'), 'NIVELADO:AAAAAAAAAAA');
    assert.equal((await listFor(ANA))[0]!.nivelada, true);
    assert.equal(k7.progresso.size, 0);
  });
});
