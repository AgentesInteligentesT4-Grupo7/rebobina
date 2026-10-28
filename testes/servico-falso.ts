import fs from 'node:fs';
import path from 'node:path';
import type { DownloadRequest, DownloadResult, YtdlpClient } from '../extensao/YtdlpClient.js';

export const PLAYLIST = ['https://youtu.be/AAAAAAAAAAA', 'https://youtu.be/BBBBBBBBBBB', 'https://youtu.be/CCCCCCCCCCC'];

/**
 * Serviço de mentira: cada link vira "<id>.mp3", menos os de `failing`, que voltam como falha.
 * Avisa a cada arquivo pronto (como o cliente real ao copiar durante o download).
 */
export function fakeClient(failing: Set<string>, calls: DownloadRequest[]): YtdlpClient {
  return {
    download: async (request: DownloadRequest, targetDir: string, _progress?: unknown, onUpdate?: (r: DownloadResult) => void) => {
      calls.push(request);
      const links = request.links?.length ? request.links : PLAYLIST;
      const ids = links.map((l) => l.slice(-11));
      const result: DownloadResult = { files: [], failures: [], skipped: [], ...(request.links ? {} : { title: 'Playlist de teste' }), order: ids };
      for (const [i, id] of ids.entries()) {
        if (failing.has(id)) {
          result.failures.push({ link: links[i]!, motivo: 'vídeo privado' });
          continue;
        }
        fs.mkdirSync(targetDir, { recursive: true });
        const file = path.join(targetDir, `${id}.mp3`);
        fs.writeFileSync(file, id);
        result.files.push({ path: file, id });
        onUpdate?.({ ...result, files: [...result.files] });
      }
      return result;
    },
  } as unknown as YtdlpClient;
}
