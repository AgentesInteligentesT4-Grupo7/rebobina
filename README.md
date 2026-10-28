# 🎧 Rebobina — fita de downloads do K7

Baixa **áudio (MP3 ou WAV)** ou **vídeo (MP4)** de um link ou de uma **playlist** do YouTube e entrega os arquivos
no Telegram, no terminal ou no navegador.

## Antes de usar: o serviço de downloads

O código da fita fica em `extensao/` (o K7 não tem nada de download: só carrega a fita) e conversa com um container
com yt-dlp, ffmpeg e deno (sem GPU), que também é desta fita. Na pasta da fita:

```bash
docker compose -f servicos/ytdlp/docker-compose.yml up -d --build
curl http://127.0.0.1:8899/health
```

## Rodar

```bash
npm run chat -- --perfil rebobina   # terminal
npm run web -- --perfil rebobina    # chat no navegador
npm run dev -- --perfil rebobina    # Telegram (usa o bot do .env desta fita ou, sem ele, o do tocador)
```

## Exemplos

- "baixa em mp3 https://youtu.be/..."
- "quero esse vídeo em mp4: https://www.youtube.com/watch?v=..."
- "baixa essa playlist inteira em mp3: https://www.youtube.com/playlist?list=..."
- "só os 10 primeiros dessa playlist, em wav: https://www.youtube.com/playlist?list=..."

Os arquivos ficam em `workspace/rebobina/downloads` no K7. No Telegram, áudio chega como música e vídeo como vídeo.
Bots do Telegram só enviam até **50 MB**: acima disso, o bot avisa onde o arquivo ficou salvo no computador.
Playlists: inteiras por padrão (`MIDIA_MAX_ITENS` no `.env` da fita põe um teto, se quiser).
Vídeos excluídos, privados ou bloqueados são pulados e listados no fim, com o link e o motivo.
Nomes padronizados, sem numeração e sem "(Official Video)" e afins.

No navegador, quando vierem vários arquivos: **Baixar tudo (.zip)** ou, no Chrome/Edge em `localhost`,
**Salvar numa pasta…** (você escolhe a pasta e as músicas vão direto para ela).

No chat web, a fita traz um painel (`web/painel.js`): biblioteca das playlists com player, **.zip** da playlist,
**tentar de novo** os links que falharam e uma **pasta do computador** (Chrome/Edge) onde as músicas são niveladas
(−14 LUFS) e ganham o nome padronizado "Título - Artista", tudo numa pasta `rebobina`.

## Comandos e testes (na pasta do K7)

```bash
npm run fita -- rebobina padronizar   # padroniza nomes e etiquetas da pasta de downloads
npm run fita -- rebobina testes       # testes da fita (não dependem do tocador)
```

## Estrutura

```
extensao/   index.ts (ativar), BaixarYoutube, YtdlpClient, MediaLibrary, MediaDownloader, AudioLeveler, rotas
web/        painel.js e painel.css (biblioteca, player, pasta, nivelar, analisar)
servicos/   ytdlp: Dockerfile, docker-compose.yml, server.py, nomes.py (regras dos nomes)
skills/     baixar-youtube
testes/     *.test.ts e um K7 de mentira (k7-falso.ts)
```

## Direitos

Os termos do YouTube restringem downloads. Use para vídeos seus, com licença livre (Creative Commons, domínio
público) ou com permissão do autor.

## Quando parar de baixar

O YouTube muda com frequência e o yt-dlp acompanha. Se os downloads começarem a falhar, suba a versão do yt-dlp
em `servicos/ytdlp/Dockerfile` e reconstrua o serviço (`up -d --build`).
