import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AudioLeveler, LEVELABLE } from './AudioLeveler.js';
import { YOUTUBE, downloadAll, planDownloads, publishProgress } from './BaixarYoutube.js';
import { UserFacingError, userMessage } from './erros.js';
import type { FitaApi, WebRotaCtx } from './k7.js';
import type { MediaDownloader } from './MediaDownloader.js';
import type { MediaLibrary } from './MediaLibrary.js';
import type { MediaFormat, YtdlpClient } from './YtdlpClient.js';

const ID = '([0-9a-f]{24})';

/**
 * Rotas do painel da Rebobina no chat web (todas em /api/x/): biblioteca das playlists, faixas para o player,
 * .zip, nivelar, medir e padronizar arquivos da pasta do visitante, tentar de novo os links que falharam.
 */
export function registrarRotas(
  k7: FitaApi,
  library: MediaLibrary,
  downloader: MediaDownloader,
  leveler: AudioLeveler,
  levelParallel: number,
  client?: YtdlpClient,
  maxItems = 0,
): void {
  const { rota } = k7.web;
  // Nivelamentos ao mesmo tempo por visitante: o número vem do serviço, pelos núcleos da máquina dele.
  const levelSlots = k7.util.limitador(levelParallel);

  rota('GET', /^\/api\/x\/info$/, (ctx) => ctx.json({ nivelar: true, nivelarParalelo: levelParallel }));

  // Playlists baixadas pelo visitante, com a URL de cada faixa para o player.
  rota('GET', /^\/api\/x\/biblioteca$/, (ctx) =>
    ctx.json(
      library.list(ctx.userId).map((entry) => ({
        id: entry.id,
        titulo: entry.titulo,
        formato: entry.formato,
        criadoEm: entry.criadoEm,
        falhas: entry.falhas ?? [],
        nivelada: entry.nivelada === true,
        faixas: entry.faixas.map((track) => ({ nome: track.nome, arquivo: track.arquivo, url: `/api/x/biblioteca/${entry.id}/${library.indexOf(entry.id, track.arquivo)}` })),
      })),
    ),
  );

  // Faixa e .zip: abertos por <audio>/<a>, sem cabeçalho de visitante; o id da entrada é imprevisível.
  rota(
    'GET',
    new RegExp(`^\\/api\\/x\\/biblioteca\\/${ID}\\/(\\d{1,5})$`),
    (ctx) => {
      const found = library.track(ctx.params[0]!, Number(ctx.params[1]));
      if (!found) return ctx.falhar(404, 'Faixa não encontrada');
      ctx.midia(found.path, found.nome);
    },
    { visitante: false },
  );
  rota(
    'GET',
    new RegExp(`^\\/api\\/x\\/biblioteca\\/${ID}\\/zip$`),
    async (ctx) => {
      const bundle = library.bundle(ctx.params[0]!);
      if (!bundle?.arquivos.length) return ctx.falhar(404, 'Playlist não encontrada');
      const plain = bundle.titulo.normalize('NFD').replace(/[̀-ͯ]/g, '');
      await ctx.zip(bundle.arquivos, `${plain.replace(/[^\w .-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 70) || 'playlist'}.zip`);
    },
    { visitante: false },
  );

  rota('DELETE', new RegExp(`^\\/api\\/x\\/biblioteca\\/${ID}$`), (ctx) => {
    if (!library.remove(ctx.userId, ctx.params[0]!)) ctx.falhar(404, 'Playlist não encontrada');
    ctx.json({ ok: true });
  });

  // Nivelar um arquivo da pasta do visitante: o corpo é o arquivo; a resposta, a versão nivelada (nada fica guardado).
  // Fora da fila de mensagens: várias músicas ao mesmo tempo. Fechou a página: quem esperava vaga nem começa.
  rota('POST', /^\/api\/x\/nivelar$/, (ctx) =>
    levelSlots.run(ctx.userId, async () => {
      if (ctx.saiu.aborted) return;
      const name = fileName(ctx);
      const response = await leveler.levelStream(body(ctx), name, ctx.saiu, ctx.url.searchParams.get('padronizar') === '1');
      const volumes = AudioLeveler.volumes(response);
      ctx.res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        ...(volumes.before !== null ? { 'x-volume-antes': String(volumes.before) } : {}),
        ...(volumes.after !== null ? { 'x-volume-depois': String(volumes.after) } : {}),
        // Nivelar e padronizar: o nome "Título - Artista" com que o arquivo deve ser gravado.
        ...(response.headers.has('x-nome') ? { 'x-nome': response.headers.get('x-nome')! } : {}),
      });
      await pipeline(Readable.fromWeb(response.body as never), ctx.res);
    }),
  );

  // Só medir o volume de um arquivo da pasta do visitante (análise, como o MP3Gain): nada é alterado.
  rota('POST', /^\/api\/x\/medir$/, (ctx) =>
    levelSlots.run(ctx.userId, async () => {
      if (ctx.saiu.aborted) return;
      ctx.json(await leveler.measureStream(body(ctx), fileName(ctx), ctx.saiu));
    }),
  );

  // Padronizar um arquivo da pasta do visitante: nome "Título - Artista" nos cabeçalhos e o arquivo com as etiquetas.
  rota('POST', /^\/api\/x\/padronizar$/, (ctx) =>
    ctx.emFila(async () => {
      const response = await leveler.standardizeStream(body(ctx), fileName(ctx));
      const pass = Object.fromEntries(['x-nome', 'x-titulo', 'x-artista'].flatMap((h) => (response.headers.has(h) ? [[h, response.headers.get(h)!]] : [])));
      ctx.res.writeHead(response.status === 204 ? 204 : 200, {
        ...(response.status === 204 ? {} : { 'content-type': 'application/octet-stream' }),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        // A página lê o nome novo destes cabeçalhos (fetch só expõe os personalizados com esta lista).
        'access-control-expose-headers': 'x-nome, x-titulo, x-artista',
        ...pass,
      });
      if (response.status === 204 || !response.body) return void ctx.res.end();
      await pipeline(Readable.fromWeb(response.body as never), ctx.res);
    }),
  );

  // Nivela no servidor todas as faixas de uma playlist baixada (no lugar), com o andamento na barra de %.
  rota('POST', new RegExp(`^\\/api\\/x\\/biblioteca\\/${ID}\\/nivelar$`), async (ctx) =>
    ctx.json(
      await ctx.emFila(async () => {
        const entryId = ctx.params[0]!;
        const files = library.files(ctx.userId, entryId).filter((f) => LEVELABLE.has(path.extname(f).toLowerCase()));
        if (!files.length) return { ok: false, erro: 'Playlist não encontrada ou sem faixas.' };
        const problems: string[] = [];
        let done = 0;
        ctx.progresso(`🔊 Nivelando 0 de ${files.length}…`, { done: 0, total: files.length });
        try {
          await k7.util.emParalelo(files, levelParallel, async (file) => {
            // Fechou a página: as faixas que faltam não começam (as já começadas terminam e ficam niveladas).
            if (ctx.saiu.aborted) return;
            try {
              await leveler.levelFile(file);
            } catch (error) {
              problems.push(`${path.basename(file)}: ${userMessage(error)}`);
            }
            done++;
            ctx.progresso(`🔊 Nivelando ${done} de ${files.length}…`, { done, total: files.length });
          });
        } finally {
          ctx.limparProgresso();
        }
        if (ctx.saiu.aborted) {
          k7.log.info(`🔊 Nivelamento interrompido: a página foi fechada (${done} de ${files.length})`);
          return { ok: false, erro: 'interrompido' };
        }
        library.markLeveled(ctx.userId, entryId, problems.length === 0);
        return { ok: true, niveladas: files.length - problems.length, problemas: problems };
      }),
    ),
  );

  // ── YouTube dentro do painel: procurar, abrir uma playlist e baixar o que a pessoa marcar (sem copiar links) ──
  if (client) {
    rota('GET', /^\/api\/x\/youtube\/pesquisar$/, async (ctx) => {
      const query = (ctx.url.searchParams.get('q') ?? '').trim().slice(0, 200);
      if (!query) return ctx.falhar(400, 'Diga o que procurar');
      try {
        if (ctx.url.searchParams.get('tipo') === 'playlist') return ctx.json({ playlists: await client.searchPlaylists(query, 12) });
        ctx.json({ videos: await client.search(query, 15) });
      } catch (error) {
        ctx.falhar(502, `A busca no YouTube falhou agora (${userMessage(error)}). Tente de novo.`);
      }
    });

    rota('GET', /^\/api\/x\/youtube\/playlist$/, async (ctx) => {
      const url = (ctx.url.searchParams.get('url') ?? '').trim();
      if (!YOUTUBE.test(url)) return ctx.falhar(400, 'Só links do YouTube');
      try {
        ctx.json(await client.listPlaylist(url, 500));
      } catch (error) {
        ctx.falhar(502, `Não consegui abrir a playlist (${userMessage(error)}).`);
      }
    });
  }

  // Baixar direto do painel (sem o modelo): vídeos marcados e playlists inteiras, cada playlist na própria entrada.
  rota('POST', /^\/api\/x\/baixar$/, async (ctx) => {
    const body = ((await ctx.lerJson()) ?? {}) as { links?: unknown; playlists?: unknown; formato?: unknown };
    const formato: MediaFormat = body.formato === 'wav' || body.formato === 'mp4' ? body.formato : 'mp3';
    let plans;
    try {
      plans = planDownloads({ links: body.links, playlists: body.playlists });
    } catch (error) {
      if (error instanceof UserFacingError) return ctx.falhar(400, error.userMessage);
      throw error;
    }
    ctx.json(
      await ctx.emFila(async () => {
        try {
          const outcome = await downloadAll(downloader, plans, { formato, maxItens: maxItems || undefined, userId: ctx.userId }, (progress, prefix) =>
            publishProgress(ctx, progress, prefix),
          );
          return {
            ok: true,
            arquivos: outcome.files.length,
            novos: outcome.fresh,
            reaproveitados: outcome.reused,
            alternativas: outcome.alternatives.length,
            falhas: outcome.failures,
            partes: outcome.parts,
          };
        } catch (error) {
          if (error instanceof UserFacingError) return { ok: false, erro: error.userMessage };
          throw error;
        } finally {
          ctx.limparProgresso();
        }
      }),
    );
  });

  // Direto, sem o modelo: baixa só os links que falharam e soma à mesma playlist.
  rota('POST', new RegExp(`^\\/api\\/x\\/biblioteca\\/${ID}\\/tentar-de-novo$`), async (ctx) =>
    ctx.json(
      await ctx.emFila(async () => {
        try {
          const outcome = await downloader.retry(ctx.userId, ctx.params[0]!, (progress) => publishProgress(ctx, progress)).finally(() => ctx.limparProgresso());
          return { ok: true, novos: outcome.fresh + outcome.reused, falhas: outcome.failures };
        } catch (error) {
          if (error instanceof UserFacingError) return { ok: false, erro: error.userMessage };
          throw error;
        }
      }),
    ),
  );
}

function fileName(ctx: WebRotaCtx): string {
  const name = path.basename(ctx.url.searchParams.get('nome') ?? '');
  return name || ctx.falhar(400, 'Informe o nome do arquivo');
}

function body(ctx: WebRotaCtx): ReadableStream<Uint8Array> {
  return Readable.toWeb(ctx.req) as ReadableStream<Uint8Array>;
}
