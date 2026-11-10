# 🎧 Rebobina — fita de downloads do K7

Baixa **áudio (MP3 ou WAV)** ou **vídeo (MP4)** de um link ou de uma **playlist** do YouTube e entrega os arquivos
no Telegram, no terminal ou no navegador. Sem link, procura pelo **nome da música ou do artista** e mostra alguns
vídeos para a pessoa escolher.

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
- "baixa essas três playlists em mp3: <link 1> <link 2> <link 3>" → uma depois da outra, cada uma na sua entrada
- "procura a música X da banda Y" → lista com 5 vídeos (título, canal, duração, link) → "baixa o 2 em mp3"

Os arquivos ficam em `workspace/rebobina/downloads` no K7. No Telegram, áudio chega como música e vídeo como vídeo.
Bots do Telegram só enviam até **50 MB**: acima disso, o bot avisa onde o arquivo ficou salvo no computador.
Playlists: inteiras por padrão (`MIDIA_MAX_ITENS` no `.env` da fita põe um teto, se quiser).
Áudio que não baixa (bloqueado, restrição de idade...) é procurado pelo título em outro vídeo da mesma música, com
duração parecida, e baixado dele; a resposta diz quais vieram de outro vídeo. Os que mesmo assim falharem (e os
privados ou excluídos, que não têm título para procurar) são listados no fim, com o link e o motivo.
MP3 e WAV saem **já nivelados** (−14 LUFS, numa conversão só a partir do áudio original) e com o nome padronizado
"Título - Artista", sem numeração e sem "(Official Video)" e afins. `NIVELAR_AO_BAIXAR=0` no serviço desliga o nivelamento.

No navegador, quando vierem vários arquivos: **Baixar tudo (.zip)** ou, no Chrome/Edge em `localhost`,
**Salvar numa pasta…** (você escolhe a pasta e as músicas vão direto para ela).

No chat web, o botão **▶️ YouTube** abre a busca dentro da página: procure por música, artista ou playlist (ou
cole o link de uma playlist), veja o vídeo ali mesmo (player sem cookies, youtube-nocookie.com), abra uma playlist
para marcar só algumas músicas ou marque playlists inteiras, escolha MP3, WAV ou vídeo e baixe tudo de uma vez,
sem passar pelo modelo. As miniaturas vêm de `i.ytimg.com`; a fita declara esses dois endereços para a página.

Pedidos longos (playlist inteira, nivelar) não seguram uma conexão aberta: a página recebe o número do pedido e vai
buscando a resposta, então proxies como o Cloudflare (que cortam em 100 s) não interrompem nada.

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
