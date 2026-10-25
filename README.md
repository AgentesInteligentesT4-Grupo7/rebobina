# 🎧 Rebobina — fita de downloads do K7

Baixa **áudio (MP3 ou WAV)** ou **vídeo (MP4)** de um link ou de uma **playlist** do YouTube e entrega os arquivos
no Telegram, no terminal ou no navegador.

## Antes de usar: o serviço de downloads

A fita usa o módulo `midia` do tocador, que conversa com um container com yt-dlp e ffmpeg (sem GPU). Na pasta do K7:

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
- "baixa os 10 primeiros áudios dessa playlist em wav: https://www.youtube.com/playlist?list=..."

Os arquivos ficam em `workspace/rebobina/downloads` no K7. No Telegram, áudio chega como música e vídeo como vídeo.
Bots do Telegram só enviam até **50 MB**: acima disso, o bot avisa onde o arquivo ficou salvo no computador.
Playlists: até 25 vídeos por pedido (`MIDIA_MAX_ITENS` no `.env` do tocador, até 200).

## Direitos

Os termos do YouTube restringem downloads. Use para vídeos seus, com licença livre (Creative Commons, domínio
público) ou com permissão do autor.

## Quando parar de baixar

O YouTube muda com frequência e o yt-dlp acompanha. Se os downloads começarem a falhar, suba a versão do yt-dlp
em `servicos/ytdlp/Dockerfile` e reconstrua o serviço (`up -d --build`).
