import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import type { FitaToolCtx } from '../extensao/k7.js';
import { duration, procurarYoutube } from '../extensao/ProcurarYoutube.js';
import { YtdlpClient } from '../extensao/YtdlpClient.js';

/** Serviço de mentira: /pesquisar devolve dois vídeos (um longo) e guarda o que foi pedido. */
const asked: string[] = [];
const server = http.createServer((req, res) => {
  asked.push(req.url!);
  const url = new URL(req.url!, 'http://x');
  const videos =
    url.searchParams.get('q') === 'nada'
      ? []
      : [
          { id: 'AAAAAAAAAAA', titulo: 'Canção de Exemplo (Ao Vivo)', canal: 'Banda Exemplo', duracao: 245, visualizacoes: 1_250_000, link: 'https://youtu.be/AAAAAAAAAAA' },
          { id: 'BBBBBBBBBBB', titulo: 'Banda Exemplo - Coletânea', canal: 'Fã Clube', duracao: 3725, visualizacoes: null, link: 'https://youtu.be/BBBBBBBBBBB' },
        ];
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ videos }));
});
let base = '';
before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const ctx = (): FitaToolCtx & { progress: string[] } => {
  const progress: string[] = [];
  return { progress, progresso: (t) => void progress.push(t), limparProgresso: () => undefined, anexarMidia: () => undefined, anexarImagem: () => undefined };
};

describe('Ferramenta procurar_youtube', () => {
  it('lista numerada com título, canal, duração e link; avisa o vídeo longo; não baixa nada', async () => {
    const tool = procurarYoutube(new YtdlpClient({ baseUrl: base, timeoutMs: 5_000 }));
    const c = ctx();
    const text = await tool.run({ busca: '  canção   de exemplo ', quantidade: 30 }, c);
    assert.match(asked.at(-1)!, /^\/pesquisar\?q=can%C3%A7%C3%A3o\+de\+exemplo&n=10$/, 'espaços limpos e no máximo 10');
    assert.match(text, /1\. Canção de Exemplo \(Ao Vivo\) — Banda Exemplo · 4:05 · 1,3 mi de views\n {3}https:\/\/youtu\.be\/AAAAAAAAAAA/);
    assert.match(text, /2\. Banda Exemplo - Coletânea — Fã Clube · 1:02:05 \(longo: pode ser álbum ou coletânea\)/);
    assert.match(text, /Não baixe sem ele escolher/);
    assert.match(c.progress[0]!, /Procurando/);
  });

  it('sem resultado pede outro jeito de escrever; busca vazia é recusada', async () => {
    const tool = procurarYoutube(new YtdlpClient({ baseUrl: base, timeoutMs: 5_000 }));
    assert.match(await tool.run({ busca: 'nada' }, ctx()), /Nenhum vídeo encontrado/);
    await assert.rejects(tool.run({ busca: '  ' }, ctx()), (e: { userMessage?: string }) => /nome da música/.test(e.userMessage ?? ''));
  });

  it('duração em m:ss ou h:mm:ss', () => {
    assert.equal(duration(59), '0:59');
    assert.equal(duration(3600), '1:00:00');
    assert.equal(duration(null), '?');
  });
});
