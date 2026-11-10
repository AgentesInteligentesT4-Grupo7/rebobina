"""Serviço local de downloads do YouTube para a fita Rebobina do K7 (yt-dlp + ffmpeg + deno).

- POST /baixar {url, formato: mp3|wav|mp4, playlist, max_itens?} → {id}; o download roda em segundo plano.
  Sem max_itens, a playlist inteira.
  Áudio sai já com nome "Título - Artista", etiquetas e volume nivelado (−14 LUFS); o que não baixar é procurado
  pelo título em outro vídeo da mesma música ("alternativas").
- GET /pesquisar?q=...&n=5 → vídeos do YouTube para um texto (nome da música, artista), sem baixar.
- GET /trabalhos/{id} → status (rodando | ok | erro), progresso e arquivos prontos.
- GET /trabalhos/{id}/arquivos/{nome} → o arquivo; DELETE /trabalhos/{id} → apaga a pasta do trabalho.
Só aceita links do YouTube. Os arquivos ficam em /downloads/<id>/ até o K7 copiá-los e apagar.
"""

import os
import re
import shutil
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import quote, urlparse
from urllib.request import Request as UrlRequest
from urllib.request import urlopen

import asyncio
import json
import subprocess

import yt_dlp
from fastapi import FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, JSONResponse, Response
from starlette.background import BackgroundTask

from nomes import filename as standard_filename
from nomes import standardize
from pydantic import BaseModel, Field

DOWNLOADS = Path("/downloads")
ALLOWED_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"}
JOB_TTL_SECONDS = 6 * 3600
# Vídeos de uma playlist baixados ao mesmo tempo (YTDLP_PARALELO). Poucos de propósito: muitos downloads
# simultâneos do mesmo IP fazem o YouTube pedir "confirme que você não é um robô" e bloquear por horas.
PARALLEL = max(1, min(6, int(os.environ.get("YTDLP_PARALELO", "3") or 3)))

app = FastAPI(title="ytdlp")
jobs: dict[str, dict] = {}
lock = threading.Lock()


class DownloadRequest(BaseModel):
    url: str = ""
    # Vários vídeos avulsos num só trabalho (ex.: vários links colados, ou tentar de novo os que falharam).
    links: list[str] = Field(default_factory=list, max_length=500)
    formato: str = Field("mp3", pattern="^(mp3|wav|mp4)$")
    playlist: bool = False
    max_itens: int | None = Field(None, ge=1)  # None = a playlist inteira
    # IDs dos vídeos (11 caracteres do link) que o K7 já tem neste formato: não são baixados de novo.
    pular: list[str] = Field(default_factory=list)
    # Áudio que não baixou: procura pelo título outro vídeo da mesma música (duração parecida) e baixa dele.
    alternativas: bool = True


def read_tags(path: Path) -> dict:
    """Etiquetas do arquivo (title, artist, encoded_by...), em minúsculas."""
    probe = subprocess.run(["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", str(path)], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
    try:
        tags = json.loads(probe.stdout or "{}").get("format", {}).get("tags") or {}
    except json.JSONDecodeError:
        return {}
    return {str(k).lower(): v for k, v in tags.items()}


def tag_args(title: str, artist: str | None) -> list[str]:
    """Argumentos do ffmpeg com título, artista e a marca encoded_by=K7 (arquivo já padronizado)."""
    return ["-metadata", f"title={title}", "-metadata", f"artist={artist or ''}", "-metadata", "encoded_by=K7"]


def write_tags(source: Path, target: Path, title: str, artist: str | None) -> None:
    """Grava título e artista (e a marca encoded_by=K7) sem mexer no áudio nem no vídeo (cópia direta)."""
    args = ["ffmpeg", "-hide_banner", "-nostdin", "-y", "-i", str(source), "-map", "0", "-c", "copy", "-map_metadata", "0", *tag_args(title, artist)]
    if source.suffix.lower() == ".mp3":
        args += ["-id3v2_version", "3"]
    run = subprocess.run([*args, str(target)], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600)
    if run.returncode != 0 or not target.is_file():
        raise RuntimeError(f"ffmpeg falhou ao gravar as etiquetas: {run.stderr[-300:]}")


def failure_reason(message: str) -> str:
    """Motivo, em português, de um vídeo que não pôde ser baixado."""
    text = message.lower()
    if "private" in text:
        return "vídeo privado"
    if "sign in to confirm your age" in text or "age-restricted" in text or "inappropriate" in text:
        return "restrição de idade (o YouTube pede login)"
    if "copyright" in text or "blocked" in text or "not available in your country" in text:
        return "bloqueado (direitos autorais ou região)"
    if "members-only" in text or "join this channel" in text:
        return "só para membros do canal"
    if "unavailable" in text or "removed" in text or "deleted" in text or "does not exist" in text or "terminated" in text:
        return "vídeo excluído ou indisponível"
    if "live event" in text or "premiere" in text:
        return "transmissão ao vivo ou estreia ainda não começou"
    return re.sub(r"^ERROR:\s*(\[[^\]]+\]\s*)?", "", message)[:200]


class JobLogger:
    """Recebe as mensagens do yt-dlp: cada vídeo que falhou vira {link, motivo} e o download segue com os outros."""

    VIDEO_ERROR = re.compile(r"\[youtube[^\]]*\]\s*([\w-]{11}):\s*(.+)")

    def __init__(self, job_id: str) -> None:
        self.job_id = job_id

    def debug(self, message: str) -> None:
        pass

    def info(self, message: str) -> None:
        pass

    def warning(self, message: str) -> None:
        pass

    def error(self, message: str) -> None:
        match = self.VIDEO_ERROR.search(message)
        failure = (
            {"link": f"https://youtu.be/{match.group(1)}", "motivo": failure_reason(match.group(2))}
            if match
            else {"link": None, "motivo": failure_reason(message)}
        )
        with lock:
            failures = jobs[self.job_id]["falhas"]
            if failure not in failures:
                failures.append(failure)



def options(job_id: str, req: DownloadRequest) -> dict:
    folder = DOWNLOADS / job_id
    # Baixa pelo id (dois vídeos de mesmo título numa playlist não se atropelam) e renomeia no fim (on_postprocess).
    opts: dict = {
        "outtmpl": str(folder / "%(id)s.%(ext)s"),
        "windowsfilenames": True,
        "noplaylist": not req.playlist,
        "playlistend": req.max_itens,
        # Vídeo excluído, privado ou bloqueado: pula, anota em "falhas" (JobLogger) e segue com os outros.
        "ignoreerrors": True,
        "logger": JobLogger(job_id),
        "quiet": True,
        "noprogress": True,
    }
    if req.formato == "mp4":
        opts["format"] = "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*[height<=1080]+ba/b"
        opts["merge_output_format"] = "mp4"
    else:
        # Áudio: baixa o original (opus/m4a) e on_postprocess converte uma vez só para MP3/WAV, já nivelado e com
        # nome e etiquetas padronizados (converter para MP3 e nivelar depois comprimiria o áudio duas vezes).
        opts["format"] = "bestaudio/best"
        opts["postprocessors"] = [{"key": "FFmpegMetadata"}]
    opts["postprocessor_hooks"] = [lambda d: on_postprocess(job_id, d, req.formato)]
    return opts


# Volume nivelado já no download (MP3/WAV). NIVELAR_AO_BAIXAR=0 desliga (o áudio sai como veio do YouTube).
LEVEL_ON_DOWNLOAD = os.environ.get("NIVELAR_AO_BAIXAR", "1").strip().lower() not in {"0", "false", "nao", "não", "off"}
# Nomes finais sendo gerados agora: duas músicas com o mesmo nome padronizado esperam uma pela outra.
in_progress: set[Path] = set()


def on_postprocess(job_id: str, d: dict, formato: str) -> None:
    """MoveFiles é o último passo do yt-dlp: o arquivo ganha "Título - Artista", as etiquetas e, no áudio, o volume
    nivelado (−14 LUFS), tudo antes de ser entregue.

    Dois vídeos com o mesmo nome padronizado são a mesma música: fica um arquivo só (sem "(2)").
    """
    if d.get("status") != "finished" or d.get("postprocessor") != "MoveFiles":
        return
    info = d.get("info_dict") or {}
    path = Path(info.get("filepath") or "")
    if not path.is_file():
        return
    # Com artista e faixa informados pelo YouTube (YouTube Music), eles valem mais que o título do vídeo.
    source = f"{info['artist']} - {info['track']}" if info.get("artist") and info.get("track") else (info.get("title") or path.stem)
    title, artist = standardize(source)
    ext = path.suffix if formato == "mp4" else f".{formato}"
    target = path.parent / f"{standard_filename(title, artist)}{ext}"
    while True:
        with lock:
            if target not in in_progress:
                duplicate = target.exists() and target != path
                if not duplicate:
                    in_progress.add(target)
                break
        time.sleep(0.5)
    leveled = False
    if duplicate:
        path.unlink(missing_ok=True)
    else:
        try:
            if formato == "mp4":
                path = path.rename(target)
                tagged = path.with_name(f".etiquetas-{uuid.uuid4().hex}{path.suffix}")
                try:
                    write_tags(path, tagged, title, artist)
                    os.replace(tagged, path)
                except Exception:  # noqa: BLE001 - sem etiqueta, o arquivo continua bom
                    tagged.unlink(missing_ok=True)
            else:
                leveled = deliver_audio(path, target, title, artist)
        except Exception as error:  # noqa: BLE001 - a conversão falhou: vira falha do vídeo, os outros seguem
            path.unlink(missing_ok=True)
            with lock:
                jobs[job_id]["falhas"].append({"link": f"https://youtu.be/{info.get('id')}", "motivo": f"não consegui converter o áudio ({str(error)[:120]})"})
            return
        finally:
            with lock:
                in_progress.discard(target)
    with lock:
        job = jobs[job_id]
        # Alternativa achada pelo título: o arquivo conta como o vídeo original (ordem da playlist e "já baixado").
        video_id = job.get("trocas", {}).get(info.get("id"), info.get("id"))
        job["arquivos"].append({"nome": target.name, "id": video_id, "titulo": title, "bytes": target.stat().st_size, "nivelado": leveled})


def deliver_audio(source: Path, target: Path, title: str, artist: str | None) -> bool:
    """Original do YouTube → MP3/WAV numa conversão só, nivelado e etiquetado. Devolve se o volume foi nivelado.

    Se o nivelamento falhar, converte sem ele (a música chega, só sem o ajuste de volume).
    """
    tags = tag_args(title, artist)
    temp = target.with_name(f".k7-{uuid.uuid4().hex}{target.suffix}")
    leveled = False
    try:
        if LEVEL_ON_DOWNLOAD:
            try:
                in_slot(lambda s, t, cancel: level_file(s, t, cancel, tags), source, temp, threading.Event())
                leveled = True
            except Exception:  # noqa: BLE001 - segue para a conversão simples
                temp.unlink(missing_ok=True)
        if not leveled:
            encode(source, temp, threading.Event(), tags=tags)
        os.replace(temp, target)
    finally:
        temp.unlink(missing_ok=True)
    if source != target:
        source.unlink(missing_ok=True)
    return leveled


VIDEO_ID = re.compile(r"(?:v=|youtu\.be/|/shorts/|/live/)([\w-]{11})")


class QuietLogger:
    """Para buscas e tentativas com alternativas: os erros delas não viram falha da lista."""

    def debug(self, message: str) -> None:
        pass

    info = warning = error = debug


def search_videos(query: str, count: int) -> list[dict]:
    """Vídeos do YouTube para um texto ("nome da música artista"), sem baixar: título, canal, duração e link."""
    with yt_dlp.YoutubeDL({"extract_flat": "in_playlist", "quiet": True, "ignoreerrors": True, "noprogress": True, "logger": QuietLogger()}) as ydl:
        info = ydl.extract_info(f"ytsearch{count}:{query}", download=False) or {}
    videos = []
    for entry in info.get("entries") or []:
        if not entry or not entry.get("id") or entry.get("live_status") in {"is_live", "is_upcoming"}:
            continue
        videos.append({
            "id": entry["id"],
            "titulo": entry.get("title") or "",
            "canal": entry.get("channel") or entry.get("uploader") or "",
            "duracao": int(entry["duration"]) if entry.get("duration") else None,
            "visualizacoes": entry.get("view_count"),
            "link": f"https://youtu.be/{entry['id']}",
        })
    return videos


def search_playlists(query: str, count: int) -> list[dict]:
    """Playlists do YouTube para um texto (a busca do site com o filtro "playlist"): título, canal, capa e link."""
    url = f"https://www.youtube.com/results?search_query={quote(query)}&sp=EgIQAw%3D%3D"
    options_ = {"extract_flat": "in_playlist", "quiet": True, "ignoreerrors": True, "noprogress": True, "playlistend": count, "logger": QuietLogger()}
    with yt_dlp.YoutubeDL(options_) as ydl:
        info = ydl.extract_info(url, download=False) or {}
    found = []
    for entry in info.get("entries") or []:
        if not entry or not entry.get("id") or "list=" not in (entry.get("url") or ""):
            continue
        thumbs = [t.get("url") for t in entry.get("thumbnails") or [] if t.get("url", "").startswith("https://i.ytimg.com/")]
        found.append({
            "id": entry["id"],
            "titulo": entry.get("title") or "",
            "canal": entry.get("channel") or entry.get("uploader") or "",
            "capa": thumbs[0] if thumbs else None,
            "link": f"https://www.youtube.com/playlist?list={entry['id']}",
        })
    return found[:count]


def list_playlist(url: str, count: int) -> dict:
    """Vídeos de uma playlist (ou canal), sem baixar: para a pessoa escolher quais quer."""
    options_ = {"extract_flat": "in_playlist", "quiet": True, "ignoreerrors": True, "noprogress": True, "playlistend": count, "logger": QuietLogger()}
    with yt_dlp.YoutubeDL(options_) as ydl:
        info = ydl.extract_info(url, download=False) or {}
    videos = []
    for entry in info.get("entries") or []:
        if not entry or not entry.get("id") or len(entry["id"]) != 11:
            continue
        videos.append({
            "id": entry["id"],
            "titulo": entry.get("title") or "",
            "canal": entry.get("channel") or entry.get("uploader") or "",
            "duracao": int(entry["duration"]) if entry.get("duration") else None,
            "link": f"https://youtu.be/{entry['id']}",
        })
    return {"titulo": info.get("title") or "", "videos": videos}


# Título que a playlist mostra no lugar de um vídeo privado ou excluído: não dá para procurar por ele.
UNUSABLE_TITLE = re.compile(r"^\[(?:private|deleted|unavailable)[^\]]*\]$", re.IGNORECASE)


def alternatives(title: str, duration: int | None, exclude: str) -> list[dict]:
    """Outros vídeos da mesma música: busca por "artista título" (sem "(Official Video)" e afins) e fica com os de
    duração parecida (até 15% ou 20 s de diferença); sem a duração original, os de até 15 min."""
    name, artist = standardize(title)
    found = search_videos(f"{artist or ''} {name}".strip(), 6)

    def close(video: dict) -> bool:
        if video["id"] == exclude or not video["duracao"]:
            return False
        if duration:
            return abs(video["duracao"] - duration) <= max(20, duration * 0.15)
        return video["duracao"] <= 15 * 60

    return [video for video in found if close(video)]


def lookup_title(video_id: str) -> str | None:
    """Título "música - canal" de um vídeo que não baixou, para procurar outro (links avulsos não trazem o título).
    O oEmbed do YouTube responde mesmo para muitos vídeos que o download recusa; excluído ou privado: None."""
    url = f"https://www.youtube.com/oembed?format=json&url={quote(f'https://www.youtube.com/watch?v={video_id}', safe='')}"
    try:
        with urlopen(UrlRequest(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=10) as response:
            data = json.loads(response.read().decode("utf-8", "replace"))
    except Exception:  # noqa: BLE001 - sem título, sem busca
        return None
    title = (data.get("title") or "").strip()
    author = re.sub(r"\s*-\s*Topic$", "", (data.get("author_name") or "").strip())
    # "Música" sem o artista no título: o canal costuma ser o artista (canais "Artista - Topic" do YouTube Music).
    return f"{author} - {title}" if title and author and " - " not in title and author.lower() not in title.lower() else title or None


def has_file(job_id: str, video_id: str) -> bool:
    with lock:
        return any(f.get("id") == video_id for f in jobs[job_id]["arquivos"])


def try_alternative(job_id: str, req: DownloadRequest, video_id: str, title: str | None, duration: int | None) -> None:
    """O áudio não baixou: tenta até 2 outros vídeos da mesma música. Deu certo, a falha sai da lista e vira
    "alternativa" (link original → link usado); senão, o motivo diz que a busca foi feita."""
    original = f"https://youtu.be/{video_id}"
    if not title or UNUSABLE_TITLE.match(title.strip()):
        title = lookup_title(video_id)
    if not title:
        return
    try:
        candidates = alternatives(title, duration, video_id)[:2]
    except Exception:  # noqa: BLE001 - busca fora do ar: fica a falha original
        candidates = []
    for video in candidates:
        with lock:
            jobs[job_id].setdefault("trocas", {})[video["id"]] = video_id
        try:
            with yt_dlp.YoutubeDL({**options(job_id, req), "logger": QuietLogger()}) as ydl:
                ydl.download([video["link"]])
        finally:
            with lock:
                jobs[job_id]["trocas"].pop(video["id"], None)
        if has_file(job_id, video_id):
            with lock:
                job = jobs[job_id]
                job["falhas"] = [f for f in job["falhas"] if f.get("link") != original]
                job["alternativas"].append({"link": original, "usado": video["link"], "titulo": video["titulo"]})
            return
    with lock:
        for failure in jobs[job_id]["falhas"]:
            if failure.get("link") == original and "procurei" not in failure["motivo"]:
                failure["motivo"] += " (procurei outro vídeo pelo título e nenhum baixou)"
                failure["titulo"] = title


def playlist_entries(job_id: str, req: DownloadRequest) -> tuple[str | None, list[tuple[str, str | None, str | None, int | None]]]:
    """Título e (link, id, título, duração) dos vídeos da playlist, sem baixar. Excluídos/privados entram e falham no
    download, com motivo; o título e a duração servem para procurar outro vídeo da mesma música."""
    listing = {"extract_flat": "in_playlist", "quiet": True, "ignoreerrors": True, "logger": JobLogger(job_id), "playlistend": req.max_itens}
    with yt_dlp.YoutubeDL(listing) as ydl:
        info = ydl.extract_info(req.url, download=False) or {}
    entries = [entry for entry in info.get("entries") or [] if entry and (entry.get("url") or entry.get("id"))]
    return info.get("title"), [
        (entry.get("url") or f"https://www.youtube.com/watch?v={entry['id']}", entry.get("id"), entry.get("title"), int(entry["duration"]) if entry.get("duration") else None)
        for entry in entries
    ]


def single_entry(url: str) -> tuple[str, str | None, str | None, int | None]:
    found = VIDEO_ID.search(url)
    return url, found.group(1) if found else None, None, None


def download_one(job_id: str, req: DownloadRequest, entry: tuple[str, str | None, str | None, int | None], total: int) -> None:
    url, video_id, title, duration = entry
    single = req.model_copy(update={"playlist": False})
    with yt_dlp.YoutubeDL(options(job_id, single)) as ydl:
        ydl.download([url])
    if single.formato != "mp4" and single.alternativas and video_id and not has_file(job_id, video_id):
        try_alternative(job_id, single, video_id, title, duration)
    with lock:
        job = jobs[job_id]
        job["feitos"] = job.get("feitos", 0) + 1
        job["progresso"] = f"{job['feitos']}/{total}"


def run(job_id: str, req: DownloadRequest) -> None:
    try:
        if req.links:
            title, entries = None, [single_entry(link) for link in req.links]
        elif req.playlist:
            title, entries = playlist_entries(job_id, req)
        else:
            title, entries = None, [single_entry(req.url)]
        # Já baixados antes (pular) e repetidos dentro da própria playlist: não baixa de novo.
        known, todo, skipped, order = set(req.pular), [], [], []
        for entry in entries:
            video_id = entry[1]
            if video_id and video_id not in order:
                order.append(video_id)
            if video_id and video_id in known:
                if video_id in req.pular and video_id not in skipped:
                    skipped.append(video_id)
                continue
            if video_id:
                known.add(video_id)
            todo.append(entry)
        with lock:
            jobs[job_id]["pulados"] = skipped
            # Para a biblioteca do K7: nome da playlist e a ordem original (os downloads em paralelo terminam fora de ordem).
            jobs[job_id]["titulo"] = title
            jobs[job_id]["ordem"] = order
            jobs[job_id]["progresso"] = f"0/{len(todo)}"
        # Alguns vídeos ao mesmo tempo (PARALLEL); cada um no próprio YoutubeDL.
        with ThreadPoolExecutor(max_workers=PARALLEL if req.playlist or len(todo) > 1 else 1) as pool:
            list(pool.map(lambda entry: download_one(job_id, req, entry, len(todo)), todo))
        with lock:
            job = jobs[job_id]
            job["status"] = "ok" if job["arquivos"] or job["pulados"] else "erro"
            if job["status"] == "erro":
                reasons = sorted({f["motivo"] for f in job["falhas"]})
                job["erro"] = f"nenhum arquivo baixado ({'; '.join(reasons) or 'vídeo indisponível'})"
    except Exception as error:  # noqa: BLE001 - qualquer falha do yt-dlp vira mensagem para o usuário
        with lock:
            jobs[job_id].update(status="erro", erro=str(error)[:500])


def cleanup_old_jobs() -> None:
    while True:
        time.sleep(600)
        limit = time.time() - JOB_TTL_SECONDS
        with lock:
            old = [job_id for job_id, job in jobs.items() if job["criado"] < limit]
            for job_id in old:
                jobs.pop(job_id)
        for job_id in old:
            shutil.rmtree(DOWNLOADS / job_id, ignore_errors=True)


threading.Thread(target=cleanup_old_jobs, daemon=True).start()


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "yt_dlp": yt_dlp.version.__version__, "nucleos": CPU_CORES, "nivelar_paralelo": LEVEL_PARALLEL, "nivelar_ao_baixar": LEVEL_ON_DOWNLOAD}


@app.get("/pesquisar")
def search(q: str, n: int = 5, tipo: str = "video") -> dict:
    """Procura no YouTube (nome da música, artista...): até `n` vídeos (1 a 20) ou, com tipo=playlist, playlists."""
    query = re.sub(r"\s+", " ", q).strip()[:200]
    if not query:
        raise HTTPException(400, "diga o que procurar (nome da música, artista ou vídeo)")
    count = max(1, min(20, n))
    try:
        if tipo == "playlist":
            return {"playlists": search_playlists(query, count)}
        return {"videos": search_videos(query, count)}
    except Exception as error:  # noqa: BLE001 - o YouTube recusou ou mudou: mensagem curta
        raise HTTPException(502, f"a busca no YouTube falhou: {str(error)[:200]}") from error


@app.get("/listar")
def listing(url: str, n: int = 300) -> dict:
    """Vídeos de uma playlist do YouTube (até `n`, 1 a 1000), sem baixar: para escolher quais baixar."""
    if not re.match(r"^https?://(?:(?:www|m|music)\.)?(?:youtube\.com|youtu\.be)/", url):
        raise HTTPException(400, "só links do YouTube")
    try:
        return list_playlist(url, max(1, min(1000, n)))
    except Exception as error:  # noqa: BLE001
        raise HTTPException(502, f"não consegui abrir a playlist: {str(error)[:200]}") from error


# ── Nivelamento de volume (EBU R128, ffmpeg loudnorm em duas passadas) ─────────
TARGET_LUFS = float(os.environ.get("NIVELAR_LUFS", "-14") or -14)  # padrão das plataformas de música
# Nivelamentos ao mesmo tempo: cada um ocupa um núcleo (o loudnorm do ffmpeg não divide o trabalho), então o padrão
# é descoberto pelo processador da máquina: todos os núcleos menos 2, que ficam para os downloads e o resto.
# NIVELAR_PARALELO força um número. Os pedidos além disso esperam a vez.
CPU_CORES = os.cpu_count() or 2
LEVEL_PARALLEL = max(1, min(32, int(os.environ.get("NIVELAR_PARALELO") or 0) or CPU_CORES - 2))
level_slots = threading.BoundedSemaphore(LEVEL_PARALLEL)
LEVEL_DIR = Path("/tmp/nivelar")
MAX_LEVEL_BYTES = 2 * 1024**3
# Codec de áudio por extensão: o arquivo nivelado sai no mesmo formato. Vídeo: a imagem é copiada, só o áudio muda.
AUDIO_CODECS = {
    ".mp3": ["-c:a", "libmp3lame", "-b:a", "192k"],
    ".wav": ["-c:a", "pcm_s16le"],
    ".m4a": ["-c:a", "aac", "-b:a", "192k"],
    ".aac": ["-c:a", "aac", "-b:a", "192k"],
    ".ogg": ["-c:a", "libvorbis", "-q:a", "6"],
    ".opus": ["-c:a", "libopus", "-b:a", "160k"],
    ".flac": ["-c:a", "flac"],
    ".mp4": ["-c:v", "copy", "-c:a", "aac", "-b:a", "192k"],
    ".mkv": ["-c:v", "copy", "-c:a", "aac", "-b:a", "192k"],
    ".webm": ["-c:v", "copy", "-c:a", "libopus", "-b:a", "160k"],
    ".mov": ["-c:v", "copy", "-c:a", "aac", "-b:a", "192k"],
}


class Cancelled(Exception):
    """Quem pediu foi embora (fechou a página): o trabalho para no meio."""


def run_ffmpeg(args: list[str], cancel: threading.Event, timeout: int) -> tuple[int, str]:
    """Roda o ffmpeg e o interrompe na hora se `cancel` for marcado (ou se passar do tempo)."""
    proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    deadline = time.time() + timeout
    while True:
        try:
            _, err = proc.communicate(timeout=0.5)
            return proc.returncode, err.decode("utf-8", "replace")
        except subprocess.TimeoutExpired:
            if cancel.is_set() or time.time() > deadline:
                proc.kill()
                proc.communicate()
                raise Cancelled() if cancel.is_set() else HTTPException(504, "o nivelamento passou do tempo")


def encode(source: Path, target: Path, cancel: threading.Event, af: str | None = None, tags: list[str] | tuple = ()) -> None:
    """Converte `source` para o formato de `target` (pela extensão), com filtro de áudio e etiquetas opcionais.

    Mesmo formato: todas as faixas (vídeo copiado, capa). Formato diferente (original do YouTube → MP3/WAV): só o áudio.
    """
    ext = target.suffix.lower()
    same = source.suffix.lower() == ext
    rate = "48000" if ext in {".opus", ".webm"} else "44100"
    args = ["ffmpeg", "-hide_banner", "-nostdin", "-y", "-i", str(source), "-map", "0" if same else "0:a:0", "-map_metadata", "0"]
    if af:
        args += ["-af", af]
    args += ["-ar", rate, *AUDIO_CODECS[ext], *tags]
    if tags and ext == ".mp3":
        args += ["-id3v2_version", "3"]
    code, err = run_ffmpeg([*args, str(target)], cancel, 3600)
    if code != 0 or not target.is_file():
        raise HTTPException(500, f"ffmpeg falhou ao converter: {err[-300:]}")


def level_file(source: Path, target: Path, cancel: threading.Event | None = None, tags: list[str] | tuple = ()) -> dict:
    """Mede o volume (1ª passada) e aplica a correção exata (2ª), sem distorcer. Devolve o volume antes e depois.

    `target` pode ter outra extensão (converte junto, numa passada só) e `tags` grava título e artista.
    """
    cancel = cancel or threading.Event()
    base = f"loudnorm=I={TARGET_LUFS}:TP=-1.5:LRA=11"
    code, err = run_ffmpeg(
        ["ffmpeg", "-hide_banner", "-nostdin", "-i", str(source), "-af", f"{base}:print_format=json", "-vn", "-f", "null", "-"], cancel, 1800,
    )
    found = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", err)
    if code != 0 or not found:
        raise HTTPException(422, "não consegui ler o áudio desse arquivo")
    m = json.loads(found.group(0))
    measured = (
        f"{base}:measured_I={m['input_i']}:measured_TP={m['input_tp']}:measured_LRA={m['input_lra']}"
        f":measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true"
    )
    encode(source, target, cancel, af=measured, tags=tags)
    return {"antes": float(m["input_i"]), "depois": TARGET_LUFS}


def standardize_file(source: Path, target: Path, nome: str) -> dict:
    tags = read_tags(source)
    title, artist = standardize(Path(nome).stem, tags)
    new_name = f"{standard_filename(title, artist)}{source.suffix.lower() if not Path(nome).suffix else Path(nome).suffix}"
    unchanged = tags.get("encoded_by") == "K7" and tags.get("title") == title and (tags.get("artist") or None) == artist
    if not unchanged:
        write_tags(source, target, title, artist)
    return {"nome": new_name, "titulo": title, "artista": artist or "", "mudou": not unchanged}


@app.post("/padronizar")
async def standardize_endpoint(request: Request, nome: str) -> Response:
    """Recebe o arquivo (nome= é o nome atual) e devolve o nome "Título - Artista" nos cabeçalhos.

    Corpo da resposta: o arquivo com título e artista gravados nas etiquetas; 204 quando as etiquetas já estavam
    certas (aí só o nome pode ter mudado e quem chamou só renomeia).
    """
    ext = Path(nome).suffix.lower()
    if ext not in AUDIO_CODECS:
        raise HTTPException(415, f"formato {ext or '(sem extensão)'} não suportado")
    work = LEVEL_DIR / uuid.uuid4().hex
    work.mkdir(parents=True)
    source, target = work / f"in{ext}", work / f"out{ext}"
    size = 0
    with source.open("wb") as out:
        async for chunk in request.stream():
            size += len(chunk)
            if size > MAX_LEVEL_BYTES:
                shutil.rmtree(work, ignore_errors=True)
                raise HTTPException(413, "arquivo grande demais (até 2 GB)")
            out.write(chunk)
    try:
        result = await run_in_threadpool(standardize_file, source, target, nome)
    except Exception as error:
        shutil.rmtree(work, ignore_errors=True)
        raise HTTPException(500, str(error)[:300]) from error
    headers = {"X-Nome": quote(result["nome"]), "X-Titulo": quote(result["titulo"]), "X-Artista": quote(result["artista"])}
    if not result["mudou"]:
        shutil.rmtree(work, ignore_errors=True)
        return Response(status_code=204, headers=headers)
    return FileResponse(target, headers=headers, background=BackgroundTask(shutil.rmtree, work, ignore_errors=True))


def measure_file(source: Path, cancel: threading.Event) -> dict:
    """Só mede (como a análise do MP3Gain): volume integrado em LUFS, pico e o ganho que falta para o alvo."""
    code, err = run_ffmpeg(
        ["ffmpeg", "-hide_banner", "-nostdin", "-i", str(source), "-af", f"loudnorm=I={TARGET_LUFS}:TP=-1.5:LRA=11:print_format=json", "-vn", "-f", "null", "-"],
        cancel, 1800,
    )
    found = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", err)
    if code != 0 or not found:
        raise HTTPException(422, "não consegui ler o áudio desse arquivo")
    m = json.loads(found.group(0))
    lufs = float(m["input_i"])
    return {"lufs": round(lufs, 1), "pico": round(float(m["input_tp"]), 1), "alvo": TARGET_LUFS, "ganho": round(TARGET_LUFS - lufs, 1)}


def in_slot(fn, *args):
    """Roda `fn(*args, cancel)` ocupando uma das LEVEL_PARALLEL vagas; cancelado na fila, nem começa."""
    *rest, cancel = args
    while not level_slots.acquire(timeout=0.5):
        if cancel.is_set():
            raise Cancelled()
    try:
        if cancel.is_set():
            raise Cancelled()
        return fn(*rest, cancel)
    finally:
        level_slots.release()


async def receive_file(request: Request, nome: str) -> tuple[Path, Path]:
    """Grava o corpo do pedido numa pasta de trabalho; devolve (pasta, arquivo)."""
    ext = Path(nome).suffix.lower()
    if ext not in AUDIO_CODECS:
        raise HTTPException(415, f"formato {ext or '(sem extensão)'} não suportado")
    work = LEVEL_DIR / uuid.uuid4().hex
    work.mkdir(parents=True)
    source = work / f"in{ext}"
    size = 0
    with source.open("wb") as out:
        async for chunk in request.stream():
            size += len(chunk)
            if size > MAX_LEVEL_BYTES:
                shutil.rmtree(work, ignore_errors=True)
                raise HTTPException(413, "arquivo grande demais (até 2 GB)")
            out.write(chunk)
    return work, source


async def while_connected(request: Request, fn, *args):
    """Roda `fn` numa thread conferindo a conexão: quem pediu fechou a página, o ffmpeg para na hora."""
    cancel = threading.Event()
    task = asyncio.ensure_future(run_in_threadpool(in_slot, fn, *args, cancel))
    while not task.done():
        if await request.is_disconnected():
            cancel.set()
            break
        await asyncio.wait({task}, timeout=0.5)
    return await task


@app.post("/nivelar")
async def level(request: Request, nome: str, padronizar: bool = False) -> Response:
    """Recebe o arquivo no corpo (nome= dá a extensão) e devolve a versão nivelada no mesmo formato.

    padronizar=1: o nivelado já sai com título e artista nas etiquetas e o nome "Título - Artista" no cabeçalho X-Nome.
    """
    work, source = await receive_file(request, nome)
    target = work / f"out{source.suffix}"
    try:
        result = await while_connected(request, level_file, source, target)
        headers = {"X-Volume-Antes": f"{result['antes']:.1f}", "X-Volume-Depois": f"{result['depois']:.1f}"}
        if padronizar:
            tags = await run_in_threadpool(read_tags, source)
            title, artist = standardize(Path(nome).stem, tags)
            tagged = work / f"tag{source.suffix}"
            await run_in_threadpool(write_tags, target, tagged, title, artist)
            target = tagged
            headers["X-Nome"] = quote(f"{standard_filename(title, artist)}{Path(nome).suffix}")
    except Cancelled:
        shutil.rmtree(work, ignore_errors=True)
        return Response(status_code=499)
    except Exception:
        shutil.rmtree(work, ignore_errors=True)
        raise
    return FileResponse(target, filename=Path(nome).name, headers=headers, background=BackgroundTask(shutil.rmtree, work, ignore_errors=True))


@app.post("/medir")
async def measure(request: Request, nome: str) -> Response:
    """Só mede o volume (nada é alterado): {lufs, pico, alvo, ganho}."""
    work, source = await receive_file(request, nome)
    try:
        return JSONResponse(await while_connected(request, measure_file, source))
    except Cancelled:
        return Response(status_code=499)
    finally:
        shutil.rmtree(work, ignore_errors=True)


@app.post("/baixar")
def download(req: DownloadRequest) -> dict:
    urls = req.links or [req.url]
    if not all((urlparse(u).hostname or "").lower() in ALLOWED_HOSTS for u in urls):
        raise HTTPException(400, "só links do YouTube (youtube.com, youtu.be, music.youtube.com)")
    job_id = uuid.uuid4().hex[:12]
    with lock:
        jobs[job_id] = {"status": "rodando", "progresso": "0/?", "arquivos": [], "falhas": [], "pulados": [], "alternativas": [], "erro": None, "criado": time.time()}
    threading.Thread(target=run, args=(job_id, req), daemon=True).start()
    return {"id": job_id}


@app.get("/trabalhos/{job_id}")
def status(job_id: str) -> dict:
    with lock:
        job = jobs.get(job_id)
        if not job:
            raise HTTPException(404, "trabalho não encontrado")
        return {k: v for k, v in job.items() if k not in {"criado", "trocas"}}


@app.get("/trabalhos/{job_id}/arquivos/{nome}")
def file(job_id: str, nome: str) -> FileResponse:
    folder = (DOWNLOADS / job_id).resolve()
    path = (folder / nome).resolve()
    if folder not in path.parents or not path.is_file():
        raise HTTPException(404, "arquivo não encontrado")
    return FileResponse(path, filename=nome)


@app.delete("/trabalhos/{job_id}")
def remove(job_id: str) -> dict:
    with lock:
        jobs.pop(job_id, None)
    shutil.rmtree(DOWNLOADS / job_id, ignore_errors=True)
    return {"ok": True}
