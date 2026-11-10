import fs from 'node:fs';
import path from 'node:path';
import { UserFacingError } from './erros.js';
import type { FitaTool, FitaToolCtx } from './k7.js';
import type { MediaDownloadOutcome, MediaDownloader } from './MediaDownloader.js';
import type { MediaFormat } from './YtdlpClient.js';

export const YOUTUBE = /^https?:\/\/(?:(?:www|m|music)\.)?(?:youtube\.com|youtu\.be)\//i;
/** Link só de playlist (list= sem v=): baixa a playlist inteira. */
const PLAYLIST_ONLY = (link: string) => /[?&]list=/.test(link) && !/[?&]v=|youtu\.be\//.test(link);
/** Arquivos listados um a um na resposta da ferramenta (playlists inteiras não lotam o contexto do modelo). */
const MAX_LISTED = 20;
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;

/** Andamento para a tela: "⬇️ Baixando 120 de 400…" com os números para a barra de %. */
export function publishProgress(ctx: Pick<FitaToolCtx, 'progresso'>, progress: string, prefix = ''): void {
  const [done, total] = progress.split('/');
  const counts = total && total !== '?' ? { done: Number(done), total: Number(total) } : undefined;
  ctx.progresso(`${prefix}${counts ? `⬇️ Baixando ${done} de ${total}…` : '⬇️ Lendo a playlist…'}`, counts);
}

/** Um download do pedido: uma playlist inteira, ou os vídeos avulsos juntos numa lista. */
export interface DownloadPlan {
  url?: string;
  links?: string[];
  playlist: boolean;
}

/**
 * Separa o que veio no pedido: cada playlist é um download (vira uma entrada própria na biblioteca, com o nome dela)
 * e os vídeos avulsos vão juntos num só. Link de playlist posto entre os vídeos também conta como playlist.
 */
export function planDownloads(input: { url?: unknown; links?: unknown; playlists?: unknown; playlist?: unknown }): DownloadPlan[] {
  const list = (value: unknown) => (Array.isArray(value) ? value.map((l) => String(l).trim()).filter(Boolean) : []);
  const url = typeof input.url === 'string' ? input.url.trim() : '';
  const all = [url, ...list(input.links), ...list(input.playlists)].filter(Boolean);
  if (!all.length) throw new UserFacingError('Informe o link (url), os links ou as playlists.');
  if (!all.every((l) => YOUTUBE.test(l))) throw new UserFacingError('Só links do YouTube (youtube.com, youtu.be, music.youtube.com).');
  const playlists = [
    ...new Set([...(url && (input.playlist === true || PLAYLIST_ONLY(url)) ? [url] : []), ...list(input.links).filter(PLAYLIST_ONLY), ...list(input.playlists)]),
  ];
  const videos = [...new Set([...(url && !playlists.includes(url) ? [url] : []), ...list(input.links).filter((l) => !PLAYLIST_ONLY(l))])];
  return [
    ...playlists.map((link) => ({ url: link, playlist: true })),
    // Um vídeo só vai como url (o serviço baixa só ele, mesmo que o link tenha list=); vários, juntos numa lista.
    ...(videos.length === 1 ? [{ url: videos[0]!, playlist: false }] : videos.length ? [{ links: videos, playlist: false }] : []),
  ];
}

export type DownloadAllOutcome = MediaDownloadOutcome & { parts: Array<{ titulo: string; arquivos: number; falhas: number }> };

/** Baixa os downloads do pedido um depois do outro (cada um já usa vários vídeos ao mesmo tempo) e soma o resultado. */
export async function downloadAll(
  downloader: MediaDownloader,
  plans: DownloadPlan[],
  options: { formato: MediaFormat; maxItens?: number | undefined; userId?: string | undefined },
  onProgress: (progress: string, prefix: string) => void,
): Promise<DownloadAllOutcome> {
  const total: DownloadAllOutcome = { files: [], fresh: 0, reused: 0, failures: [], alternatives: [], leveled: 0, parts: [] };
  for (const [i, plan] of plans.entries()) {
    const prefix = plans.length > 1 ? `📀 ${i + 1} de ${plans.length} · ` : '';
    let outcome: MediaDownloadOutcome;
    try {
      outcome = await downloader.download(
        {
          ...(plan.links ? { links: plan.links } : { url: plan.url! }),
          formato: options.formato,
          playlist: plan.playlist,
          maxItens: options.maxItens,
          ...(options.userId ? { userId: options.userId } : {}),
        },
        (progress) => onProgress(progress, prefix),
      );
    } catch (error) {
      // Uma playlist que não abre (privada, link errado) não para as outras.
      if (plans.length === 1) throw error;
      const motivo = error instanceof UserFacingError ? error.userMessage : error instanceof Error ? error.message : String(error);
      total.failures.push({ link: plan.url ?? plan.links?.join(' ') ?? null, motivo });
      total.parts.push({ titulo: plan.url ?? `${plan.links?.length} link(s)`, arquivos: 0, falhas: 1 });
      continue;
    }
    total.files.push(...outcome.files.filter((f) => !total.files.includes(f)));
    total.fresh += outcome.fresh;
    total.reused += outcome.reused;
    total.failures.push(...outcome.failures);
    total.alternatives.push(...outcome.alternatives);
    total.leveled += outcome.leveled;
    total.parts.push({ titulo: outcome.entry?.titulo ?? plan.url ?? 'Download', arquivos: outcome.files.length, falhas: outcome.failures.length });
  }
  return total;
}

/**
 * baixar_youtube: baixa áudio (MP3/WAV) ou vídeo (MP4) de um link, de vários links ou de uma playlist do YouTube
 * para `<workspace>/downloads` e entrega os arquivos pelo canal (Telegram, terminal ou navegador).
 *
 * @param maxItems teto de vídeos por playlist (MIDIA_MAX_ITENS); 0 = sem limite.
 */
export function baixarYoutube(downloader: MediaDownloader, maxItems: number, log: (msg: string) => void): FitaTool {
  return {
    name: 'baixar_youtube',
    description:
      'Baixa áudio (mp3 ou wav) ou vídeo (mp4) de um link do YouTube, de vários links de uma vez, ou de todos os vídeos de uma ou mais playlists, ' +
      'e entrega os arquivos ao usuário. Áudio sai com nome padronizado e volume nivelado; o que não baixar é procurado pelo título em outro vídeo. ' +
      'Só links youtube.com, youtu.be ou music.youtube.com (sem link, use procurar_youtube antes).',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Link do vídeo ou da playlist no YouTube (um só).' },
        links: { type: 'array', items: { type: 'string' }, description: 'Vários links de vídeos de uma vez (em vez de url): baixados juntos, numa só lista.' },
        formato: { type: 'string', enum: ['mp3', 'wav', 'mp4'], description: 'mp3 (áudio, padrão), wav (áudio sem perda) ou mp4 (vídeo).' },
        playlists: {
          type: 'array',
          items: { type: 'string' },
          description: 'Links de playlists para baixar inteiras, uma ou várias de uma vez (cada uma vira uma playlist na biblioteca).',
        },
        playlist: { type: 'boolean', description: 'true para baixar os vídeos da playlist do link (url); false (padrão) só o vídeo.' },
        max_itens: {
          type: 'integer',
          description: `Só se o usuário pedir uma quantidade ("os 10 primeiros"); sem ele, a playlist inteira${maxItems ? ` (até ${maxItems})` : ''}.`,
        },
      },
      additionalProperties: false,
    },

    async run(args, ctx) {
      // Link só de playlist (sem v=): baixa a playlist mesmo que o modelo esqueça de pedir.
      const plans = planDownloads(args);
      const formato = (typeof args.formato === 'string' ? args.formato : 'mp3') as MediaFormat;
      const playlist = plans.some((p) => p.playlist);
      const asked = Number(args.max_itens) > 0 ? Math.floor(Number(args.max_itens)) : undefined;
      // Sem pedido e sem teto configurado: a playlist inteira.
      const maxItens = maxItems ? Math.min(maxItems, asked ?? maxItems) : asked;

      const started = Date.now();
      // O canal mostra o andamento enquanto espera ("Baixando 120 de 400…"): playlists inteiras levam minutos.
      const { files, fresh, reused, failures, alternatives, leveled, parts } = await downloadAll(downloader, plans, { formato, maxItens, userId: ctx.userId }, (progress, prefix) => {
        log(`⬇️ ${formato} ${prefix}${progress}`);
        publishProgress(ctx, progress, prefix);
      });

      const kind = formato === 'mp4' ? 'video' : 'audio';
      for (const file of files) ctx.anexarMidia(file, kind);
      log(`✅ ${fresh} novo(s) e ${reused} reaproveitado(s), ${formato}, em ${Math.round((Date.now() - started) / 1000)} s`);

      const lines = files.slice(0, MAX_LISTED).map((file) => `- ${path.basename(file)} (${mb(fs.statSync(file).size)})`);
      if (files.length > MAX_LISTED) lines.push(`- ... e mais ${files.length - MAX_LISTED}`);
      return [
        `ok: ${files.length} arquivo(s) ${formato.toUpperCase()}: ${fresh} baixado(s) agora e ${reused} que já tinham sido baixados antes ` +
          `(reaproveitados, sem baixar de novo). Os arquivos já são entregues ao usuário junto da sua resposta e aparecem na biblioteca (não repita os caminhos).`,
        formato !== 'mp4' && fresh
          ? `Nomes padronizados ("Título - Artista")${leveled ? ` e volume nivelado (−14 LUFS) em ${leveled === fresh ? 'todos os novos' : `${leveled} de ${fresh}`}` : ''}.`
          : '',
        ...(parts.length > 1
          ? ['Por playlist:', ...parts.map((p) => `- ${p.titulo}: ${p.arquivos} arquivo(s)${p.falhas ? `, ${p.falhas} com problema` : ''}`), 'Arquivos:']
          : []),
        ...lines,
        playlist && maxItens && fresh >= maxItens ? `(parou em ${maxItens} vídeos da playlist${maxItems ? `, o teto de MIDIA_MAX_ITENS` : ''})` : '',
        alternatives.length
          ? `\n${alternatives.length} áudio(s) não baixaram do link original e vieram de outro vídeo da mesma música, achado pelo título. ` +
            `Conte isso ao usuário em uma frase e liste (original → usado):\n` +
            alternatives.map((a) => `- ${a.link} → ${a.usado} (${a.titulo})`).join('\n')
          : '',
        failures.length
          ? `\n${failures.length} vídeo(s) com problema foram pulados. INFORME AO USUÁRIO cada um, com o link e o motivo, ` +
            `e que dá para tentar de novo só esses pelo botão da playlist na biblioteca:\n` +
            failures.map((f) => `- ${f.link ?? '(sem link)'}: ${f.motivo}`).join('\n')
          : '',
      ]
        .filter(Boolean)
        .join('\n');
    },
  };
}
