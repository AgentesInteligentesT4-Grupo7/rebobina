import path from 'node:path';
import { AudioLeveler } from './AudioLeveler.js';
import { baixarYoutube } from './BaixarYoutube.js';
import { errorMessage } from './erros.js';
import type { FitaApi } from './k7.js';
import { MediaDownloader } from './MediaDownloader.js';
import { MediaLibrary } from './MediaLibrary.js';
import { procurarYoutube } from './ProcurarYoutube.js';
import { registrarRotas } from './rotas.js';
import { YtdlpClient } from './YtdlpClient.js';

/**
 * Extensão da Rebobina: downloads do YouTube pelo serviço yt-dlp (servicos/ytdlp desta fita), a busca de vídeos pelo
 * nome da música, a biblioteca e o
 * player no chat web, nivelar o volume e padronizar os nomes. O tocador K7 não tem nada disso: só carrega a fita.
 *
 * Configuração (no .env do tocador ou da fita):
 *   YTDLP_BASE_URL   endereço do serviço (padrão http://127.0.0.1:8899)
 *   MIDIA_TIMEOUT_MS espera máxima de um download (padrão 4 h: playlists inteiras demoram)
 *   MIDIA_MAX_ITENS  teto de vídeos de uma playlist por pedido (0, o padrão, = sem limite)
 */
export default async function ativar(k7: FitaApi): Promise<void> {
  const { env } = k7.fita;
  const options = {
    baseUrl: (env.YTDLP_BASE_URL?.trim() || 'http://127.0.0.1:8899').replace(/\/+$/, ''),
    timeoutMs: positiveInt(env.MIDIA_TIMEOUT_MS, 4 * 3600_000),
  };
  const maxItems = Math.max(0, Math.floor(Number(env.MIDIA_MAX_ITENS ?? 0)) || 0);

  const client = new YtdlpClient(options);
  const library = new MediaLibrary(k7.fita.workspaceDir);
  const downloader = new MediaDownloader(client, k7.fita.workspaceDir, library);
  const leveler = new AudioLeveler(options);

  k7.ferramenta(baixarYoutube(downloader, maxItems, k7.log.info));
  k7.ferramenta(procurarYoutube(client));
  // Quantas músicas nivelar de uma vez: o serviço descobre pelos núcleos da máquina dele (fora do ar, 2).
  registrarRotas(k7, library, downloader, leveler, await leveler.parallel(), client, maxItems);
  // Busca do YouTube no painel: miniaturas (i.ytimg.com) e o player do vídeo (youtube-nocookie.com, sem cookies).
  k7.web.painel({ script: 'web/painel.js', estilo: 'web/painel.css', imagens: ['https://i.ytimg.com'], quadros: ['https://www.youtube-nocookie.com'] });

  // npm run fita -- rebobina padronizar
  k7.comando('padronizar', 'Padroniza nomes e etiquetas da pasta de downloads ("Título - Artista"); repetidas viram uma só', async () => {
    process.stdout.write(`✏️ Padronizando ${path.join(k7.fita.workspaceDir, 'downloads')}\n`);
    const result = await downloader.standardizeAll(leveler, (done, total, name) => {
      process.stdout.write(`\r  ${done + 1}/${total} ${name.slice(0, 70).padEnd(70)}`);
    });
    process.stdout.write(
      `\n✅ ${result.total} arquivo(s): ${result.renamed} renomeado(s), ${result.merged} repetido(s) unido(s)` +
        `${result.problems.length ? `, ${result.problems.length} com problema:\n  ${result.problems.join('\n  ')}` : ''}\n`,
    );
  });

  k7.aoIniciar(async () => {
    try {
      k7.log.info(`⬇️ Downloads do YouTube: yt-dlp ${await client.healthCheck()} em ${options.baseUrl}`);
    } catch (error) {
      k7.log.aviso(`⚠️ Serviço de downloads fora do ar em ${options.baseUrl} (${errorMessage(error)}). Na pasta da fita: docker compose -f servicos/ytdlp/docker-compose.yml up -d --build`);
    }
  });
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
