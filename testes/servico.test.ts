import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { UserFacingError } from '../extensao/erros.js';
import { YtdlpClient } from '../extensao/YtdlpClient.js';

/** Serviço ytdlp de mentira: o primeiro status responde "rodando", o seguinte "ok" (ou o erro pedido). */
function fakeService(behavior: { error?: string; files?: Array<{ nome: string; conteudo: string }>; falhas?: Array<{ link: string | null; motivo: string }> }) {
  const requests: Array<{ method: string; url: string; body?: unknown }> = [];
  let polls = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      requests.push({ method: req.method!, url: req.url!, ...(raw ? { body: JSON.parse(raw) } : {}) });
      const json = (status: number, body: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
      if (req.url === '/baixar') return json(200, { id: 'abc' });
      if (req.url === '/trabalhos/abc' && req.method === 'GET') {
        polls++;
        if (polls === 1) return json(200, { status: 'rodando', progresso: '0/?', arquivos: [], erro: null });
        const falhas = behavior.falhas ?? [];
        if (behavior.error) return json(200, { status: 'erro', progresso: '1/1', arquivos: [], falhas, erro: behavior.error });
        const arquivos = (behavior.files ?? []).map((f) => ({ nome: f.nome, bytes: f.conteudo.length }));
        return json(200, { status: 'ok', progresso: `${arquivos.length}/${arquivos.length}`, arquivos, falhas, erro: null });
      }
      const file = (behavior.files ?? []).find((f) => req.url === `/trabalhos/abc/arquivos/${encodeURIComponent(f.nome)}`);
      if (file) return res.writeHead(200).end(file.conteudo);
      if (req.method === 'DELETE') return json(200, { ok: true });
      json(404, { detail: 'não encontrado' });
    });
  });
  return { server, requests };
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('Cliente do serviço yt-dlp', () => {
  const ok = fakeService({
    files: [{ nome: 'Musica.mp3', conteudo: 'ID3-audio' }],
    falhas: [{ link: 'https://youtu.be/AAAAAAAAAAA', motivo: 'vídeo privado' }],
  });
  let okUrl = '';
  before(async () => (okUrl = await listen(ok.server)));
  after(() => ok.server.close());

  it('pede o download, acompanha até terminar, copia o arquivo e apaga o trabalho; o mesmo nome não vira "(2)"', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'midia-'));
    const progress: string[] = [];
    const client = new YtdlpClient({ baseUrl: okUrl, timeoutMs: 5_000, pollMs: 10 });
    const { files, failures } = await client.download({ url: 'https://youtu.be/x', formato: 'mp3', playlist: false, maxItens: 25 }, dir, (p) => progress.push(p));
    assert.deepEqual(files.map((f) => path.basename(f.path)), ['Musica.mp3']);
    assert.deepEqual(failures, [{ link: 'https://youtu.be/AAAAAAAAAAA', motivo: 'vídeo privado' }], 'vídeo pulado volta com link e motivo');
    assert.equal(fs.readFileSync(files[0]!.path, 'utf8'), 'ID3-audio');
    assert.deepEqual(progress, ['0/?', '1/1']);
    assert.deepEqual(ok.requests[0]!.body, { url: 'https://youtu.be/x', formato: 'mp3', playlist: false, max_itens: 25 });
    assert.equal(ok.requests.at(-1)!.method, 'DELETE');

    // O nome já vem padronizado ("Título - Artista"): se já existe, é a mesma música e o arquivo é reaproveitado.
    const again = fs.mkdtempSync(path.join(os.tmpdir(), 'midia-'));
    fs.writeFileSync(path.join(again, 'Musica.mp3'), 'antigo');
    const second = await client.download({ url: 'https://youtu.be/x', formato: 'mp3', playlist: false }, again);
    assert.deepEqual(second.files.map((f) => path.basename(f.path)), ['Musica.mp3']);
    assert.deepEqual(fs.readdirSync(again), ['Musica.mp3'], 'sem "Musica (2).mp3"');
  });

  it('erro do yt-dlp vira mensagem que a pessoa entende; serviço fora do ar diz como subir', async () => {
    const failing = fakeService({
      error: 'ERROR: [youtube] abc: Private video. Sign in if you have access',
      falhas: [{ link: 'https://youtu.be/BBBBBBBBBBB', motivo: 'vídeo privado' }],
    });
    const url = await listen(failing.server);
    try {
      const client = new YtdlpClient({ baseUrl: url, timeoutMs: 5_000, pollMs: 10 });
      await assert.rejects(
        client.download({ url: 'https://youtu.be/x', formato: 'mp4', playlist: false, maxItens: 1 }, os.tmpdir()),
        /o vídeo é privado[\s\S]*https:\/\/youtu\.be\/BBBBBBBBBBB: vídeo privado/,
      );
      assert.equal(failing.requests.at(-1)!.method, 'DELETE', 'apaga o trabalho mesmo com erro');
    } finally {
      failing.server.close();
    }
    const offline = new YtdlpClient({ baseUrl: 'http://127.0.0.1:9', timeoutMs: 1_000 });
    await assert.rejects(offline.healthCheck(), (error: unknown) => error instanceof UserFacingError && /docker compose -f servicos\/ytdlp/.test(error.userMessage));
  });
});
