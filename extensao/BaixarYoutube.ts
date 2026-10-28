import fs from 'node:fs';
import path from 'node:path';
import { UserFacingError } from './erros.js';
import type { FitaTool, FitaToolCtx } from './k7.js';
import type { MediaDownloader } from './MediaDownloader.js';
import type { MediaFormat } from './YtdlpClient.js';

const YOUTUBE = /^https?:\/\/(?:(?:www|m|music)\.)?(?:youtube\.com|youtu\.be)\//i;
/** Arquivos listados um a um na resposta da ferramenta (playlists inteiras não lotam o contexto do modelo). */
const MAX_LISTED = 20;
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;

/** Andamento para a tela: "⬇️ Baixando 120 de 400…" com os números para a barra de %. */
export function publishProgress(ctx: Pick<FitaToolCtx, 'progresso'>, progress: string): void {
  const [done, total] = progress.split('/');
  const counts = total && total !== '?' ? { done: Number(done), total: Number(total) } : undefined;
  ctx.progresso(counts ? `⬇️ Baixando ${done} de ${total}…` : '⬇️ Lendo a playlist…', counts);
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
      'Baixa áudio (mp3 ou wav) ou vídeo (mp4) de um link do YouTube, de vários links de uma vez, ou de todos os vídeos de uma playlist, ' +
      'e entrega os arquivos ao usuário. Só links youtube.com, youtu.be ou music.youtube.com.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Link do vídeo ou da playlist no YouTube (um só).' },
        links: { type: 'array', items: { type: 'string' }, description: 'Vários links de vídeos de uma vez (em vez de url): baixados juntos, numa só lista.' },
        formato: { type: 'string', enum: ['mp3', 'wav', 'mp4'], description: 'mp3 (áudio, padrão), wav (áudio sem perda) ou mp4 (vídeo).' },
        playlist: { type: 'boolean', description: 'true para baixar os vídeos da playlist do link; false (padrão) só o vídeo.' },
        max_itens: {
          type: 'integer',
          description: `Só se o usuário pedir uma quantidade ("os 10 primeiros"); sem ele, a playlist inteira${maxItems ? ` (até ${maxItems})` : ''}.`,
        },
      },
      additionalProperties: false,
    },

    async run(args, ctx) {
      const links = Array.isArray(args.links) ? [...new Set(args.links.map((l) => String(l).trim()).filter(Boolean))] : [];
      const url = typeof args.url === 'string' ? args.url.trim() : '';
      if (!url && !links.length) throw new UserFacingError('Informe o link (url) ou os links.');
      if (![url, ...links].filter(Boolean).every((l) => YOUTUBE.test(l))) throw new UserFacingError('Só links do YouTube (youtube.com, youtu.be, music.youtube.com).');
      const formato = (typeof args.formato === 'string' ? args.formato : 'mp3') as MediaFormat;
      // Link só de playlist (sem v=): baixa a playlist mesmo que o modelo esqueça de pedir.
      const playlist = !links.length && (args.playlist === true || (/[?&]list=/.test(url) && !/[?&]v=|youtu\.be\//.test(url)));
      const asked = Number(args.max_itens) > 0 ? Math.floor(Number(args.max_itens)) : undefined;
      // Sem pedido e sem teto configurado: a playlist inteira.
      const maxItens = maxItems ? Math.min(maxItems, asked ?? maxItems) : asked;

      const started = Date.now();
      // O canal mostra o andamento enquanto espera ("Baixando 120 de 400…"): playlists inteiras levam minutos.
      const { files, fresh, reused, failures } = await downloader.download(
        { ...(links.length ? { links } : { url }), formato, playlist, maxItens, ...(ctx.userId ? { userId: ctx.userId } : {}) },
        (progress) => {
          log(`⬇️ ${formato} ${progress}`);
          publishProgress(ctx, progress);
        },
      );

      const kind = formato === 'mp4' ? 'video' : 'audio';
      for (const file of files) ctx.anexarMidia(file, kind);
      log(`✅ ${fresh} novo(s) e ${reused} reaproveitado(s), ${formato}, em ${Math.round((Date.now() - started) / 1000)} s`);

      const lines = files.slice(0, MAX_LISTED).map((file) => `- ${path.basename(file)} (${mb(fs.statSync(file).size)})`);
      if (files.length > MAX_LISTED) lines.push(`- ... e mais ${files.length - MAX_LISTED}`);
      return [
        `ok: ${files.length} arquivo(s) ${formato.toUpperCase()}: ${fresh} baixado(s) agora e ${reused} que já tinham sido baixados antes ` +
          `(reaproveitados, sem baixar de novo). Os arquivos já são entregues ao usuário junto da sua resposta e aparecem na biblioteca (não repita os caminhos).`,
        ...lines,
        playlist && maxItens && fresh >= maxItens ? `(parou em ${maxItens} vídeos da playlist${maxItems ? `, o teto de MIDIA_MAX_ITENS` : ''})` : '',
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
