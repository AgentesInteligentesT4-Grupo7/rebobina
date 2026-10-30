import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { baixarYoutube } from '../extensao/BaixarYoutube.js';
import type { FitaToolCtx } from '../extensao/k7.js';
import { MediaDownloader } from '../extensao/MediaDownloader.js';
import { MediaLibrary } from '../extensao/MediaLibrary.js';
import type { DownloadRequest, YtdlpClient } from '../extensao/YtdlpClient.js';
import { PLAYLIST, fakeClient } from './servico-falso.js';

/** O que o tocador entrega à ferramenta: quem pediu, andamento e os arquivos que vão junto da resposta. */
function fakeCtx(userId?: string): FitaToolCtx & { media: Array<[string, string]>; progress: string[] } {
  const media: Array<[string, string]> = [];
  const progress: string[] = [];
  return { ...(userId ? { userId } : {}), media, progress, progresso: (t) => void progress.push(t), limparProgresso: () => undefined, anexarMidia: (p, k) => void media.push([p, k]), anexarImagem: () => undefined };
}

describe('Ferramenta baixar_youtube', () => {
  it('só aceita YouTube; link só de playlist baixa a playlist; arquivos vão junto da resposta', async () => {
    const calls: unknown[] = [];
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'midia-ws-'));
    const client = {
      download: async (request: unknown, targetDir: string) => {
        calls.push(request);
        fs.mkdirSync(targetDir, { recursive: true });
        const file = path.join(targetDir, 'Aula.mp4');
        fs.writeFileSync(file, 'video');
        return {
          files: [{ path: file, id: 'VIDEOAULA01' }],
          failures: calls.length === 1 ? [{ link: 'https://youtu.be/CCCCCCCCCCC', motivo: 'vídeo excluído ou indisponível' }] : [],
          skipped: [],
        };
      },
    } as unknown as YtdlpClient;
    const tool = baixarYoutube(new MediaDownloader(client, workspace), 25, () => undefined);

    await assert.rejects(tool.run({ url: 'https://vimeo.com/123' }, fakeCtx()), (e: { userMessage?: string }) => /Só links do YouTube/.test(e.userMessage ?? ''));

    const ctx = fakeCtx();
    const output = await tool.run({ url: 'https://www.youtube.com/playlist?list=PL123', formato: 'mp4', max_itens: 500 }, ctx);
    assert.deepEqual(calls[0], { url: 'https://www.youtube.com/playlist?list=PL123', formato: 'mp4', playlist: true, maxItens: 25, pular: [] });
    assert.deepEqual(ctx.media.map(([p, k]) => [path.basename(p), k]), [['Aula.mp4', 'video']]);
    assert.match(output, /^ok: 1 arquivo\(s\) MP4/);
    assert.match(output, /1 vídeo\(s\) com problema foram pulados[\s\S]*INFORME AO USUÁRIO[\s\S]*https:\/\/youtu\.be\/CCCCCCCCCCC: vídeo excluído ou indisponível/);
    assert.equal(path.dirname(ctx.media[0]![0]), path.join(workspace, 'downloads'));

    await tool.run({ url: 'https://www.youtube.com/watch?v=abc&list=PL123' }, fakeCtx());
    assert.deepEqual(calls[1], { url: 'https://www.youtube.com/watch?v=abc&list=PL123', formato: 'mp3', playlist: false, maxItens: 25, pular: [] }, 'vídeo de uma playlist: só o vídeo');

    // Sem teto configurado (padrão): a playlist inteira, ou a quantidade pedida.
    const unlimited = baixarYoutube(new MediaDownloader(client, workspace), 0, () => undefined);
    await unlimited.run({ url: 'https://www.youtube.com/playlist?list=PL123' }, fakeCtx());
    assert.equal((calls[2] as { maxItens?: number }).maxItens, undefined);
    await unlimited.run({ url: 'https://www.youtube.com/playlist?list=PL123', max_itens: 300 }, fakeCtx());
    assert.equal((calls[3] as { maxItens?: number }).maxItens, 300);
  });

  it('música já baixada (mesmo ID e formato) não baixa de novo: o serviço pula e o arquivo existente é entregue', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'midia-indice-'));
    const requests: Array<{ pular?: string[] }> = [];
    const client = {
      download: async (request: { pular?: string[] }, targetDir: string) => {
        requests.push(request);
        fs.mkdirSync(targetDir, { recursive: true });
        if (requests.length === 1) {
          const file = path.join(targetDir, 'Artista - Musica.mp3');
          fs.writeFileSync(file, 'ID3');
          return { files: [{ path: file, id: 'IDMUSICA001' }], failures: [], skipped: [] };
        }
        // Segunda vez: o serviço recebeu o ID em "pular" e devolve que ele estava no link.
        return { files: [], failures: [], skipped: request.pular ?? [] };
      },
    } as unknown as YtdlpClient;
    const tool = baixarYoutube(new MediaDownloader(client, workspace), 0, () => undefined);

    await tool.run({ url: 'https://youtu.be/IDMUSICA001', formato: 'mp3' }, fakeCtx());
    const ctx = fakeCtx();
    const output = await tool.run({ url: 'https://youtu.be/IDMUSICA001', formato: 'mp3' }, ctx);
    assert.deepEqual(requests[1]!.pular, ['IDMUSICA001']);
    assert.deepEqual(ctx.media.map(([p]) => path.basename(p)), ['Artista - Musica.mp3']);
    assert.match(output, /0 baixado\(s\) agora e 1 que já tinham sido baixados antes/);

    // Em outro formato é outro arquivo: baixa normalmente.
    await tool.run({ url: 'https://youtu.be/IDMUSICA001', formato: 'wav' }, fakeCtx());
    assert.deepEqual(requests[2]!.pular, []);
  });
});

describe('Downloads: biblioteca crescendo, vários links e tentar de novo', () => {
  it('a playlist entra na biblioteca a cada arquivo; falhas guardadas; tentar de novo baixa só elas e soma', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'downloader-'));
    const library = new MediaLibrary(dir);
    const calls: DownloadRequest[] = [];
    const failing = new Set(['BBBBBBBBBBB']);
    const seen: number[] = [];
    const add = library.add.bind(library);
    library.add = (dono, item, entryId) => (seen.push(item.arquivos.length), add(dono, item, entryId));
    const downloader = new MediaDownloader(fakeClient(failing, calls), dir, library);

    const first = await downloader.download({ url: 'https://www.youtube.com/playlist?list=PL1', formato: 'mp3', playlist: true, userId: 'ana' });
    assert.deepEqual(seen.slice(0, 2), [1, 2], 'cada arquivo pronto já aparece');
    assert.deepEqual(first.failures, [{ link: PLAYLIST[1], motivo: 'vídeo privado' }]);
    const [entry] = library.list('ana');
    assert.equal(entry!.titulo, 'Playlist de teste');
    assert.deepEqual(entry!.faixas.map((t) => t.nome), ['AAAAAAAAAAA', 'CCCCCCCCCCC']);
    assert.deepEqual(entry!.falhas, [{ link: PLAYLIST[1], motivo: 'vídeo privado' }]);

    failing.clear();
    const retried = await downloader.retry('ana', entry!.id);
    assert.deepEqual(calls[1]!.links, [PLAYLIST[1]], 'só os que falharam');
    assert.equal(retried.failures.length, 0);
    const [again] = library.list('ana');
    assert.equal(again!.id, entry!.id, 'a mesma playlist');
    assert.deepEqual(again!.faixas.map((t) => t.nome), ['AAAAAAAAAAA', 'CCCCCCCCCCC', 'BBBBBBBBBBB']);
    assert.deepEqual(again!.falhas, []);
    await assert.rejects(downloader.retry('ana', entry!.id), /Não há links com falha/);
    await assert.rejects(downloader.retry('beto', entry!.id), /Playlist não encontrada/);

    // Vários links num pedido: uma lista só.
    const many = await downloader.download({ links: ['https://youtu.be/DDDDDDDDDDD', 'https://youtu.be/EEEEEEEEEEE'], formato: 'mp3', playlist: false, userId: 'ana' });
    assert.equal(many.files.length, 2);
    assert.match(library.list('ana')[0]!.titulo, /^2 link\(s\) de /);
  });
});

