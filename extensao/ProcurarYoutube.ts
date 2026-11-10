import { UserFacingError } from './erros.js';
import type { FitaTool } from './k7.js';
import type { FoundVideo, YtdlpClient } from './YtdlpClient.js';

/** "3:45" ou "1:02:10". */
export function duration(seconds: number | null): string {
  if (!seconds) return '?';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = String(Math.floor(seconds % 60)).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function views(count: number | null | undefined): string {
  if (!count) return '';
  if (count >= 1e9) return ` · ${(count / 1e9).toFixed(1).replace('.', ',')} bi de views`;
  if (count >= 1e6) return ` · ${(count / 1e6).toFixed(1).replace('.', ',')} mi de views`;
  if (count >= 1e3) return ` · ${Math.round(count / 1e3)} mil views`;
  return ` · ${count} views`;
}

/** Lista numerada para a pessoa escolher: título, canal, duração e link. */
export function videoList(videos: FoundVideo[]): string {
  return videos
    .map((v, i) => `${i + 1}. ${v.titulo}${v.canal ? ` — ${v.canal}` : ''} · ${duration(v.duracao)}${views(v.visualizacoes)}${v.duracao && v.duracao > 15 * 60 ? ' (longo: pode ser álbum ou coletânea)' : ''}\n   ${v.link}`)
    .join('\n');
}

/**
 * procurar_youtube: a pessoa diz o nome da música (e o artista, se souber) e a fita mostra alguns vídeos do
 * YouTube para ela escolher qual baixar. Nada é baixado aqui.
 */
export function procurarYoutube(client: YtdlpClient): FitaTool {
  return {
    name: 'procurar_youtube',
    description:
      'Procura vídeos no YouTube pelo nome da música, do artista ou do vídeo e devolve uma lista numerada (título, canal, duração, link) ' +
      'para o usuário escolher qual baixar. Use quando o usuário não mandar link. Não baixa nada.',
    parameters: {
      type: 'object',
      properties: {
        busca: { type: 'string', description: 'O que procurar, com as palavras do usuário: nome da música e, se ele disser, o artista ou a versão (ao vivo, acústico...).' },
        quantidade: { type: 'integer', description: 'Quantos vídeos mostrar (1 a 10; padrão 5).' },
      },
      required: ['busca'],
      additionalProperties: false,
    },

    async run(args, ctx) {
      const busca = typeof args.busca === 'string' ? args.busca.replace(/\s+/g, ' ').trim() : '';
      if (!busca) throw new UserFacingError('Diga o nome da música ou do artista para eu procurar.');
      const quantidade = Math.max(1, Math.min(10, Math.floor(Number(args.quantidade)) || 5));
      ctx.progresso(`🔎 Procurando "${busca.slice(0, 60)}" no YouTube…`);
      try {
        const videos = await client.search(busca, quantidade);
        if (!videos.length) return `Nenhum vídeo encontrado para "${busca}". Peça ao usuário outro jeito de escrever (nome da música e do artista).`;
        return [
          `ok: ${videos.length} vídeo(s) para "${busca}". Mostre ao usuário a lista como está (número, título, canal, duração e link) ` +
            `e pergunte qual baixar e em que formato (MP3, WAV ou MP4). Não baixe sem ele escolher. ` +
            `Quando ele escolher ("o 2", "o primeiro em mp3"), chame baixar_youtube com o link desse número.`,
          videoList(videos),
        ].join('\n');
      } finally {
        ctx.limparProgresso();
      }
    },
  };
}
