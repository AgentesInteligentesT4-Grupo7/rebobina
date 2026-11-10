/* Painel da fita Rebobina no chat do K7: biblioteca das playlists, player, pasta do computador
 * (nivelar, padronizar, analisar). O tocador só injeta este arquivo e oferece window.K7. */
(function () {
  'use strict';
  var K7 = window.K7;
  if (!K7) return;
  var $ = function (id) { return document.getElementById(id); };
  var el = K7.el, esc = K7.esc, api = K7.api, fileUrl = K7.fileUrl, authHeaders = K7.authHeaders, base = K7.base;
  var saveToFolder = K7.saveToFolder, state = K7.state;
  var fitaInfo = {};

  // Elementos do painel: botão no topo, player embaixo do chat e a barra lateral.
  var top = $('theme');
  top.insertAdjacentHTML('beforebegin', '<button id="lib-toggle" class="hidden" type="button" title="Playlists baixadas">🎵 Biblioteca</button>');
  $('composer-wrap').insertAdjacentHTML('beforebegin', "  <div id=\"player\" class=\"hidden\">\n    <div id=\"player-row\">\n      <button class=\"pbtn\" type=\"button\" id=\"p-prev\" title=\"Anterior\">\u23ee</button>\n      <button class=\"pbtn\" type=\"button\" id=\"p-next\" title=\"Pr\u00f3xima\">\u23ed</button>\n      <button class=\"pbtn\" type=\"button\" id=\"p-shuffle\" title=\"Embaralhar\">\ud83d\udd00</button>\n      <div id=\"player-title\"></div>\n      <button class=\"pbtn\" type=\"button\" id=\"p-close\" title=\"Fechar o tocador\">\u2715</button>\n    </div>\n    <audio id=\"p-audio\" controls preload=\"metadata\"></audio>\n    <video id=\"p-video\" class=\"hidden\" controls preload=\"metadata\" playsinline></video>\n  </div>\n");
  $('main').insertAdjacentHTML('afterend', "<aside id=\"lib\" class=\"hidden\" aria-label=\"Biblioteca\">\n  <div id=\"lib-head\">\ud83c\udfb5 Biblioteca <button type=\"button\" id=\"lib-close\" title=\"Fechar\">\u2715</button></div>\n  <div id=\"lib-list\"><div class=\"lib-empty\">Carregando\u2026</div></div>\n</aside>\n");

  // ── Biblioteca e tocador ───────────────────────────────────────────────────
  var lib = { list: [], open: {}, failsOpen: {}, forceSave: {}, queue: [], order: [], pos: -1, shuffle: false, entryId: null, folder: null, localEntry: null };

  /** Baixa de novo só os links que falharam (direto no serviço, sem passar pelo modelo) e soma à mesma playlist. */
  function retryFailed(entry, button) {
    button.disabled = true;
    var tick = setInterval(function () {
      api('/api/progresso').then(function (p) {
        button.textContent = p && p.total ? '↻ ' + p.feitos + ' de ' + p.total + '…' : '↻ Começando…';
      }).catch(function () {});
      loadLibrary();
    }, 2500);
    api('/api/x/biblioteca/' + entry.id + '/tentar-de-novo', { method: 'POST' })
      .then(function (r) {
        clearInterval(tick);
        if (!r.ok) { button.disabled = false; button.textContent = '⚠️ ' + (r.erro || 'falhou'); return; }
        lib.failsOpen[entry.id] = r.falhas.length > 0;
        return loadLibrary();
      })
      .catch(function (err) { clearInterval(tick); button.disabled = false; button.textContent = '⚠️ ' + err.message; });
  }
  var FORMAT_LABEL = { mp3: 'MP3', wav: 'WAV', mp4: 'Vídeo' };

  function setLibOpen(open) {
    $('lib').classList.toggle('hidden', !open);
    $('lib-toggle').classList.toggle('on', open);
    try { localStorage.setItem('libOpen', open ? '1' : '0'); } catch (e) {}
  }
  $('lib-toggle').onclick = function () { setLibOpen($('lib').classList.contains('hidden')); };
  $('lib-close').onclick = function () { setLibOpen(false); };

  function loadLibrary() {
    // Depois de cada leitura, grava na pasta escolhida o que ainda não está lá.
    return api('/api/x/biblioteca').then(function (list) { lib.list = list; openDownloading(); renderLibrary(); autoSave(); }).catch(function () {});
  }

  /**
   * A playlist que está baixando fica aberta (as músicas aparecem enquanto chegam). É a que surgiu ou mudou desde
   * que a conversa começou a trabalhar (comparando com a foto tirada no início, sem depender do relógio).
   * Se a pessoa fechar, continua fechada.
   */
  function openDownloading() {
    if (!lib.snapshot) return;
    lib.list.forEach(function (entry) {
      if (lib.snapshot[entry.id] !== entry.criadoEm && lib.open[entry.id] === undefined) lib.open[entry.id] = true;
    });
  }

  // ── Pasta do computador de quem usa (Chrome/Edge em localhost ou https) ─────
  // Escolhida uma vez e lembrada (IndexedDB): os downloads novos são gravados nela; o que já está nela vira
  // uma playlist que toca direto do computador e pode ser nivelada (a versão nivelada vai para "nivelados").
  var MEDIA_FILE = /\.(mp3|wav|m4a|aac|ogg|opus|flac|mp4|mkv|webm|mov)$/i;
  var VIDEO_FILE = /\.(mp4|mkv|webm|mov)$/i;
  var FOLDER_KEY = 'pasta:' + (base || '/');
  var canPickFolder = Boolean(window.showDirectoryPicker && window.isSecureContext);

  function idb(mode, fn) {
    return new Promise(function (resolve, reject) {
      var open = indexedDB.open('k7', 1);
      open.onupgradeneeded = function () { open.result.createObjectStore('kv'); };
      open.onerror = function () { reject(open.error); };
      open.onsuccess = function () {
        var tx = open.result.transaction('kv', mode), req = fn(tx.objectStore('kv'));
        tx.oncomplete = function () { resolve(req && req.result); };
        tx.onerror = function () { reject(tx.error); };
      };
    });
  }

  function restoreFolder() {
    if (!canPickFolder || !window.indexedDB) return Promise.resolve();
    return idb('readonly', function (store) { return store.get(FOLDER_KEY); }).then(function (saved) {
      if (!saved) return;
      lib.folder = { handle: saved.handle, name: saved.handle.name, pickedAt: saved.pickedAt, granted: false, files: [], saved: {}, status: '' };
      return saved.handle.queryPermission({ mode: 'readwrite' }).then(function (state) {
        lib.folder.granted = state === 'granted';
        return lib.folder.granted ? scanFolder() : renderLibrary();
      });
    }).catch(function () {});
  }

  function pickFolder() {
    window.showDirectoryPicker({ mode: 'readwrite' }).then(function (handle) {
      lib.folder = { handle: handle, name: handle.name, pickedAt: Date.now(), granted: true, files: [], saved: {}, status: '' };
      idb('readwrite', function (store) { return store.put({ handle: handle, pickedAt: lib.folder.pickedAt }, FOLDER_KEY); }).catch(function () {});
      return scanFolder();
    }).catch(function () {});
  }

  /** Depois de recarregar a página, o navegador pede de novo a permissão (precisa de um clique). */
  function authorizeFolder() {
    lib.folder.handle.requestPermission({ mode: 'readwrite' }).then(function (state) {
      lib.folder.granted = state === 'granted';
      if (lib.folder.granted) { scanFolder(); autoSave(); }
    }).catch(function () {});
  }

  function forgetFolder() {
    lib.folder = null; lib.localEntry = null;
    idb('readwrite', function (store) { return store.delete(FOLDER_KEY); }).catch(function () {});
    renderLibrary();
  }

  /** Lê os áudios e vídeos da pasta (só o primeiro nível) e monta a playlist local. */
  var MAX_FOLDER_FILES = 5000;
  var MAX_FOLDER_DEPTH = 8;

  /**
   * Lê os áudios e vídeos da pasta e das subpastas (menos "nivelados", que é a saída do nivelamento).
   * Cada faixa guarda o caminho relativo (`pastas`), para o nivelado ir para o mesmo lugar dentro de "nivelados".
   */
  function walkFolder(dir, pastas, files) {
    var it = dir.values();
    var next = function () {
      return it.next().then(function (r) {
        if (r.done || files.length >= MAX_FOLDER_FILES) return;
        var item = r.value;
        if (item.kind === 'file' && MEDIA_FILE.test(item.name)) {
          var caminho = pastas.concat(item.name).join('/');
          files.push({ nome: caminho.replace(/\.[^.]+$/, ''), arquivo: item.name, caminho: caminho, pastas: pastas, handle: item });
          return next();
        }
        var output = pastas.length === 0 && (item.name === 'rebobina' || item.name === 'nivelados' || item.name === 'duplicados');
        if (item.kind === 'directory' && !output && pastas.length < MAX_FOLDER_DEPTH) {
          return walkFolder(item, pastas.concat(item.name), files).then(next);
        }
        return next();
      });
    };
    return next();
  }

  function scanFolder() {
    var folder = lib.folder;
    if (!folder || !folder.granted) return Promise.resolve();
    var files = [];
    return walkFolder(folder.handle, [], files).then(function () {
      files.sort(function (a, b) { return a.caminho.localeCompare(b.caminho, 'pt-BR', { numeric: true }); });
      folder.files = files;
      // Só os do primeiro nível contam para não gravar de novo um download com o mesmo nome.
      files.forEach(function (f) { if (!f.pastas.length) folder.saved[f.arquivo] = true; });
      lib.localEntry = { id: 'pasta-local', titulo: '📁 ' + folder.name + ' (originais)', formato: 'local', faixas: files, local: true };
      return folder.handle.getDirectoryHandle('rebobina').then(function (out) {
        var done = [];
        return walkFolder(out, [], done).then(function () {
          done.sort(function (a, b) { return a.caminho.localeCompare(b.caminho, 'pt-BR', { numeric: true }); });
          lib.outEntry = done.length ? { id: 'pasta-rebobina', titulo: '🎧 rebobina (atualizada)', formato: 'local', faixas: done, local: true } : null;
        });
      }, function () { lib.outEntry = null; }).then(renderLibrary);
    }).catch(function (err) { folder.status = '⚠️ ' + err.message; renderLibrary(); });
  }

  function folderStatus(text) {
    if (!lib.folder) return;
    lib.folder.status = text;
    var node = $('folder-status');
    if (node) node.textContent = text; else renderLibrary();
  }


  /**
   * Grava na pasta as faixas que ainda não estão lá: das playlists baixadas depois de escolher a pasta
   * (ou marcadas pelo botão 📁 da playlist). Uma por vez; arquivo com o mesmo nome não é gravado de novo.
   */
  function autoSave() {
    var folder = lib.folder;
    if (!folder || !folder.granted || lib.saving) return;
    var todo = [];
    lib.list.forEach(function (entry) {
      if (Date.parse(entry.criadoEm) < folder.pickedAt && !lib.forceSave[entry.id]) return;
      entry.faixas.forEach(function (t) { if (!folder.saved[t.arquivo]) todo.push(t); });
    });
    if (!todo.length) return;
    lib.saving = true;
    var i = 0, fresh = 0;
    var one = function () {
      if (i >= todo.length) {
        lib.saving = false;
        folderStatus(fresh ? '💾 ' + fresh + ' arquivo(s) gravados na pasta' : '');
        return scanFolder().then(autoSave);
      }
      var track = todo[i++];
      folderStatus('💾 Gravando na pasta ' + i + ' de ' + todo.length + '…');
      return folder.handle.getFileHandle(track.arquivo)
        .then(function () { folder.saved[track.arquivo] = true; }, function () {
          return fetch(fileUrl(track.url)).then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status + ' em ' + track.arquivo);
            return folder.handle.getFileHandle(track.arquivo, { create: true })
              .then(function (h) { return h.createWritable(); })
              .then(function (w) { return res.body.pipeTo(w); });
          }).then(function () { folder.saved[track.arquivo] = true; fresh++; });
        })
        .catch(function (err) { folder.saved[track.arquivo] = true; folderStatus('⚠️ ' + err.message); })
        .then(one);
    };
    one();
  }

  /** Nivela os arquivos da pasta: cada um vai ao servidor, volta nivelado e é gravado em "nivelados" (o original fica). */
  /** Abre (criando) a subpasta `pastas` dentro de `dir`: "nivelados/Rock/Anos 80". */
  function subfolder(dir, pastas) {
    return pastas.reduce(function (p, name) { return p.then(function (d) { return d.getDirectoryHandle(name, { create: true }); }); }, Promise.resolve(dir));
  }

  // ── Tarefas da pasta (nivelar, padronizar): lista de todas as músicas e barra de progresso ─────────────
  // O painel é um elemento guardado em `lib.job`: a biblioteca é redesenhada a cada poucos segundos e só
  // recoloca o mesmo painel, então o andamento não se perde nem pisca.
  var JOB_STATES = {
    fila: { icon: '⏳', label: 'na fila' },
    ativo: { icon: '🔄', label: 'em andamento' },
    feito: { icon: '✓', label: 'feito' },
    pulado: { icon: '↷', label: 'pulado' },
    erro: { icon: '⚠', label: 'com problema' },
    cancelado: { icon: '✕', label: 'cancelado' },
  };

  function startJob(title, items, parallel) {
    var job = {
      title: title, parallel: parallel, started: Date.now(), done: 0, cancelled: false, finished: false,
      controllers: [], counts: { feito: 0, pulado: 0, erro: 0, cancelado: 0 },
      rows: [], el: el('div', 'job'),
    };
    var head = el('div', 'job-head');
    head.appendChild(el('b', '', esc(title)));
    var cancel = el('button', 'retry', 'Cancelar'); cancel.type = 'button';
    cancel.onclick = function () { cancelJob(job); };
    var close = el('button', 'retry hidden', 'Fechar'); close.type = 'button';
    close.onclick = function () { if (lib.job === job) { lib.job = null; renderLibrary(); } };
    head.appendChild(cancel); head.appendChild(close);
    job.cancelButton = cancel; job.closeButton = close;
    job.el.appendChild(head);
    var bar = el('div', 'bar'); bar.appendChild(el('i')); job.bar = bar.firstChild;
    job.el.appendChild(bar);
    job.meta = el('div', 'job-meta'); job.el.appendChild(job.meta);
    var filter = el('label', 'job-filter');
    var check = document.createElement('input'); check.type = 'checkbox';
    check.onchange = function () { job.el.classList.toggle('only-problems', check.checked); };
    filter.appendChild(check); filter.appendChild(document.createTextNode(' só problemas'));
    job.el.appendChild(filter);
    var list = el('div', 'job-list');
    items.forEach(function (item) {
      var row = el('div', 'job-row');
      row.dataset.state = 'fila';
      row.innerHTML = '<span class="ic">' + JOB_STATES.fila.icon + '</span><span class="nm">' + esc(item.caminho) + '</span><span class="dt"></span>';
      row.title = item.caminho;
      list.appendChild(row);
      job.rows.push(row);
    });
    job.el.appendChild(list);
    job.timer = setInterval(function () { updateJob(job); }, 1000);
    lib.job = job;
    updateJob(job);
    renderLibrary();
    return job;
  }

  function setJobRow(job, index, state, detail, extra) {
    var row = job.rows[index];
    var previous = row.dataset.state;
    row.dataset.state = state;
    row.querySelector('.ic').textContent = JOB_STATES[state].icon;
    row.querySelector('.ic').title = JOB_STATES[state].label;
    row.querySelector('.dt').textContent = detail || '';
    if (extra && extra.level) row.dataset.level = extra.level;
    // ▶ original / ▶ nivelado: toca no player para comparar (direto do computador).
    (extra && extra.play || []).forEach(function (p) {
      var b = el('button', 'job-play', '▶ ' + esc(p.label)); b.type = 'button';
      b.onclick = function () { playPreview(p.handle, p.title); };
      row.appendChild(b);
    });
    if (state in job.counts && !(previous in job.counts)) { job.counts[state]++; job.done++; }
    if (state === 'ativo' && !job.scrolled) { job.scrolled = true; row.scrollIntoView({ block: 'nearest' }); }
    updateJob(job);
  }

  function updateJob(job) {
    var total = job.rows.length;
    var pct = total ? Math.round((job.done / total) * 100) : 100;
    var secs = Math.round(((job.finishedAt || Date.now()) - job.started) / 1000);
    var time = secs >= 60 ? Math.floor(secs / 60) + ' min ' + (secs % 60) + ' s' : secs + ' s';
    job.bar.style.width = pct + '%';
    var c = job.counts;
    var parts = [job.done + ' de ' + total + ' (' + pct + '%)', time];
    if (!job.finished) parts.push(job.parallel + ' ao mesmo tempo');
    if (c.feito) parts.push('✓ ' + c.feito);
    if (c.pulado) parts.push('↷ ' + c.pulado);
    if (c.erro) parts.push('⚠ ' + c.erro);
    if (c.cancelado) parts.push('✕ ' + c.cancelado);
    job.meta.textContent = (job.finished ? (job.cancelled ? 'Cancelado · ' : 'Concluído · ') : '') + parts.join(' · ');
  }

  function cancelJob(job) {
    if (job.finished) return;
    job.cancelled = true;
    job.controllers.forEach(function (c) { c.abort(); });
    job.cancelButton.disabled = true;
    job.cancelButton.textContent = 'Cancelando…';
  }

  /**
   * Roda `worker(item, signal)` em `job.parallel` filas; cada resultado é { state: 'feito' | 'pulado', detail }.
   * Erro vira "com problema" com a mensagem; cancelar para de puxar a fila e interrompe os envios em andamento.
   */
  function runJob(job, items, worker) {
    var next = 0;
    var one = function () {
      if (next >= items.length) return Promise.resolve();
      var index = next++;
      if (job.cancelled) { setJobRow(job, index, 'cancelado'); return one(); }
      var controller = new AbortController();
      job.controllers.push(controller);
      setJobRow(job, index, 'ativo', '');
      return Promise.resolve()
        .then(function () { return worker(items[index], controller.signal); })
        .then(function (result) { setJobRow(job, index, result.state, result.detail, result); })
        .catch(function (err) {
          if (job.cancelled) setJobRow(job, index, 'cancelado');
          else setJobRow(job, index, 'erro', err && err.message ? err.message : String(err));
        })
        .then(function () { job.controllers.splice(job.controllers.indexOf(controller), 1); return one(); });
    };
    var workers = [];
    for (var w = 0; w < Math.max(1, Math.min(job.parallel, items.length)); w++) workers.push(one());
    return Promise.all(workers).then(function () {
      job.finished = true; job.finishedAt = Date.now();
      clearInterval(job.timer);
      job.cancelButton.classList.add('hidden'); job.closeButton.classList.remove('hidden');
      updateJob(job);
      renderLibrary();
    });
  }

  function jobRunning() { return Boolean(lib.job && !lib.job.finished); }

  function failOn(res) {
    if (res.ok) return res;
    return res.json().catch(function () { return {}; }).then(function (d) { throw new Error(d.erro || ('HTTP ' + res.status)); });
  }

  /** Como o MP3Gain mostra: estava baixa (precisa subir), alta (precisa baixar) ou já no ponto. */
  function loudness(before, target) {
    var b = Number(before), t = Number(target);
    if (before === null || before === '' || isNaN(b) || isNaN(t)) return { text: '', level: '' };
    var gain = t - b, dB = (gain > 0 ? '+' : '−') + Math.abs(gain).toFixed(1).replace('.', ',') + ' dB';
    if (gain > 1) return { text: 'estava baixa (' + dB + ')', level: 'baixa' };
    if (gain < -1) return { text: 'estava alta (' + dB + ')', level: 'alta' };
    return { text: 'já estava no ponto', level: 'ok' };
  }

  /** Toca um arquivo do computador no player (comparar original e nivelado). */
  function playPreview(handle, title) {
    lib.preview = { id: 'preview', titulo: 'Comparação', formato: 'local', local: true, faixas: [{ nome: title, arquivo: handle.name, handle: handle }] };
    playEntry(lib.preview, 0);
  }

  var LUFS = function (v) { return v === null || v === '' || isNaN(Number(v)) ? '?' : Number(v).toFixed(1).replace('.', ','); };

  // ── Pasta "rebobina": a cópia de trabalho atualizada (os originais nunca são alterados) ─────────────
  // Lista de controle em rebobina/.k7-rebobina.json: caminho original → { arquivo, nivelado, padronizado }.
  // Nivelar e padronizar atualizam o mesmo arquivo de cada música em "rebobina": não se acumulam cópias.
  var OUT_DIR = 'rebobina';
  var OUT_MAP = '.k7-rebobina.json';

  function readOutMap(out) {
    return out.getFileHandle(OUT_MAP)
      .then(function (h) { return h.getFile(); })
      .then(function (f) { return f.text(); })
      .then(function (t) { return JSON.parse(t) || {}; })
      .catch(function () { return {}; });
  }

  function writeTo(dir, name, stream) {
    return dir.getFileHandle(name, { create: true })
      .then(function (h) { return h.createWritable(); })
      .then(function (w) { return stream.pipeTo(w); });
  }

  var MODES = {
    ambos: { title: '🔊✏️ Nivelando e padronizando', level: true, name: true },
    nivelar: { title: '🔊 Nivelando o volume', level: true, name: false },
    padronizar: { title: '✏️ Padronizando os nomes', level: false, name: true },
  };

  /**
   * Atualiza a pasta "rebobina" a partir dos originais:
   * - nivelar: o volume sempre parte do original (sem nivelar duas vezes) e vai para o arquivo da música em "rebobina";
   *   se ela já estava padronizada, continua com o nome e as etiquetas certos;
   * - padronizar: renomeia e grava as etiquetas do arquivo que já está em "rebobina" (o volume nivelado fica);
   *   só copia o original quando a música ainda não está lá.
   * O que já foi feito é pulado (rodar de novo continua de onde parou). Duas músicas com o mesmo nome padronizado
   * na mesma pasta são a mesma: a segunda fica como "repetida".
   */
  function processFolder(mode) {
    var folder = lib.folder, files = folder.files.slice(), m = MODES[mode];
    if (!files.length || jobRunning()) return;
    var parallel = Math.max(1, (fitaInfo.nivelarParalelo) || 2);
    var out, map, dirty = false, locks = {};
    var inFolder = function (key, fn) {
      var run = (locks[key] || Promise.resolve()).then(fn, fn);
      locks[key] = run.catch(function () {});
      return run;
    };
    var saveMap = function () {
      if (!dirty) return Promise.resolve();
      dirty = false;
      return writeTo(out, OUT_MAP, new Blob([JSON.stringify(map, null, 1)]).stream()).catch(function () {});
    };
    folder.handle.getDirectoryHandle(OUT_DIR, { create: true }).then(function (dir) {
      out = dir;
      return readOutMap(out);
    }).then(function (saved) {
      map = saved;
      var flush = setInterval(saveMap, 5000);
      var job = startJob(m.title, files, parallel);
      return runJob(job, files, function (item, signal) {
        var entry = map[item.caminho];
        var needLevel = m.level && !(entry && entry.nivelado);
        var needName = m.name && !(entry && entry.padronizado);
        return subfolder(out, item.pastas).then(function (target) {
          // Repetida de outra música (mesmo nome padronizado): continua pulada enquanto a outra estiver lá.
          if (entry && entry.repetidaDe) {
            return target.getFileHandle(entry.repetidaDe).then(function (kept) {
              return { state: 'pulado', detail: 'repetida de "' + entry.repetidaDe + '"', play: compare(item, kept) };
            }, function () { delete map[item.caminho]; dirty = true; entry = null; return null; }).then(function (skip) { return skip || processItem(); });
          }
          return processItem();
          function processItem() {
          var current = entry ? target.getFileHandle(entry.arquivo).catch(function () { return null; }) : Promise.resolve(null);
          return current.then(function (existing) {
            // A cópia sumiu de "rebobina" (apagada à mão): refaz do zero.
            if (entry && !existing) { entry = null; needLevel = m.level; needName = m.name; }
            if (!needLevel && !needName) {
              return { state: 'pulado', detail: 'já atualizada' + (entry ? ' como "' + entry.arquivo + '"' : ''), play: compare(item, existing) };
            }
            var keepName = Boolean(entry && entry.padronizado);
            var request;
            if (needLevel) {
              // Volume sempre a partir do original; padroniza junto se pedido ou se já estava padronizada.
              var standardize = needName || keepName;
              request = item.handle.getFile().then(function (file) {
                return fetch(base + '/api/x/nivelar?nome=' + encodeURIComponent(file.name) + (standardize ? '&padronizar=1' : ''),
                  { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/octet-stream' }), body: file, signal: signal });
              });
            } else {
              // Só o nome: parte do arquivo de "rebobina" (mantém o volume nivelado); sem ele, do original.
              request = (existing ? existing.getFile() : item.handle.getFile()).then(function (file) {
                // O nome a padronizar é o do original (de onde sai título e artista).
                return fetch(base + '/api/x/padronizar?nome=' + encodeURIComponent(item.arquivo),
                  { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/octet-stream' }), body: file, signal: signal })
                  .then(function (res) { res.k7Source = file; return res; });
              });
            }
            return request.then(failOn).then(function (res) {
              var named = decodeURIComponent(res.headers.get('x-nome') || '');
              var name = named || (entry ? entry.arquivo : item.arquivo);
              var before = res.headers.get('x-volume-antes'), after = res.headers.get('x-volume-depois');
              var judged = needLevel ? loudness(before, after) : { text: '', level: '' };
              var body = res.status === 204 || !res.body ? res.k7Source.stream() : res.body;
              return inFolder(item.pastas.join('/'), function () {
                var sameFile = entry && entry.arquivo.toLowerCase() === name.toLowerCase();
                var taken = sameFile ? Promise.reject(new Error('livre')) : target.getFileHandle(name);
                return taken.then(function (kept) {
                  // Outra música já ficou com esse nome nesta pasta: é a mesma. Fica registrada (não volta ao servidor)
                  // e a cópia que ela tinha em "rebobina" sai.
                  if (body.cancel) body.cancel();
                  map[item.caminho] = { repetidaDe: name };
                  dirty = true;
                  var drop = entry && existing ? target.removeEntry(entry.arquivo).catch(function () {}) : Promise.resolve();
                  return drop.then(function () { return { state: 'pulado', detail: 'repetida de "' + name + '"', play: compare(item, kept) }; });
                }, function () {
                  return writeTo(target, sameFile ? entry.arquivo : name, body).then(function () {
                    var old = entry && !sameFile ? target.removeEntry(entry.arquivo).catch(function () {}) : Promise.resolve();
                    return old.then(function () {
                      var finalName = sameFile ? entry.arquivo : name;
                      map[item.caminho] = {
                        arquivo: finalName,
                        nivelado: Boolean((entry && entry.nivelado) || needLevel),
                        padronizado: Boolean(keepName || needName),
                      };
                      dirty = true;
                      var parts = [];
                      if (needLevel) parts.push(LUFS(before) + ' → ' + LUFS(after) + ' LUFS' + (judged.text ? ' · ' + judged.text : ''));
                      if (finalName !== item.arquivo) parts.push('→ ' + finalName);
                      else if (needName) parts.push('nome já estava certo; etiquetas gravadas');
                      return target.getFileHandle(finalName).then(function (copy) {
                        return { state: 'feito', level: judged.level, detail: parts.join(' · '), play: compare(item, copy) };
                      });
                    });
                  });
                });
              });
            });
          });
          }
        });
      }).then(function () { clearInterval(flush); return saveMap(); }).then(scanFolder);
    }).catch(function (err) { folderStatus('⚠️ ' + err.message); });
  }

  /** ▶ original e ▶ rebobina, para comparar no player. */
  function compare(item, copy) {
    var play = [{ label: 'original', handle: item.handle, title: item.nome + ' (original)' }];
    if (copy) play.push({ label: 'rebobina', handle: copy, title: copy.name.replace(/\.[^.]+$/, '') + ' (rebobina)' });
    return play;
  }

  /** Só mede o volume de cada música original (nada é alterado), como a análise do MP3Gain. */
  function analyzeFolder() {
    var folder = lib.folder, files = folder.files.slice();
    if (!files.length || jobRunning()) return;
    var parallel = Math.max(1, (fitaInfo.nivelarParalelo) || 2);
    var job = startJob('📊 Analisando o volume', files, parallel);
    runJob(job, files, function (item, signal) {
      return item.handle.getFile().then(function (file) {
        return fetch(base + '/api/x/medir?nome=' + encodeURIComponent(file.name), { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/octet-stream' }), body: file, signal: signal });
      }).then(failOn).then(function (res) { return res.json(); }).then(function (v) {
        var judged = loudness(v.lufs, v.alvo);
        var peak = v.pico > -1 ? ' · pico ' + (v.pico > 0 ? '+' : '') + String(v.pico).replace('.', ',') + ' dB (pode distorcer)' : '';
        return {
          state: 'feito', level: judged.level,
          detail: LUFS(v.lufs) + ' LUFS · ' + judged.text.replace('já estava', 'já está').replace('estava', 'está') + peak,
          play: [{ label: 'ouvir', handle: item.handle, title: item.nome }],
        };
      });
    });
  }

  /** Nivela no servidor todas as faixas de uma playlist baixada. */
  function levelEntry(entry, button) {
    button.disabled = true;
    var tick = setInterval(function () {
      api('/api/progresso').then(function (p) { if (p && p.total) button.textContent = '🔊 ' + (p.feitos + 1) + '/' + p.total; }).catch(function () {});
    }, 2000);
    api('/api/x/biblioteca/' + entry.id + '/nivelar', { method: 'POST' })
      .then(function (r) { clearInterval(tick); if (!r.ok) { button.disabled = false; button.textContent = '⚠️'; button.title = r.erro || 'falhou'; return; } return loadLibrary(); })
      .catch(function (err) { clearInterval(tick); button.disabled = false; button.textContent = '⚠️'; button.title = err.message; });
  }

  function renderFolder(box) {
    if (!canPickFolder) {
      box.appendChild(el('div', 'lib-empty', '📁 Para gravar numa pasta do computador, abra pelo 127.0.0.1 no Chrome ou no Edge.'));
      return;
    }
    var card = el('div', 'pl folder-card');
    var folder = lib.folder;
    if (!folder) {
      var pick = el('button', 'pl-open');
      pick.type = 'button';
      pick.innerHTML = '<span class="pl-title">📁 Escolher pasta</span><span class="pl-meta">os downloads vão direto para ela; o que já tem nela toca e pode ser nivelado</span>';
      pick.onclick = pickFolder;
      card.appendChild(pick);
    } else if (!folder.granted) {
      var auth = el('button', 'pl-open');
      auth.type = 'button';
      auth.innerHTML = '<span class="pl-title">📁 ' + esc(folder.name) + '</span><span class="pl-meta">clique para autorizar a pasta de novo</span>';
      auth.onclick = authorizeFolder;
      card.appendChild(auth);
    } else {
      var entry = lib.localEntry || { id: 'pasta-local', titulo: '📁 ' + folder.name, formato: 'local', faixas: [], local: true };
      // Os downloads também são gravados na pasta: na lista da pasta ficam só os outros arquivos, para a mesma
      // música não aparecer em duas playlists (os botões abaixo continuam valendo para a pasta inteira).
      var downloaded = {};
      lib.list.forEach(function (e) { e.faixas.forEach(function (t) { downloaded[t.arquivo] = true; }); });
      var others = entry.faixas.filter(function (t) { return (t.pastas && t.pastas.length) || !downloaded[t.arquivo]; });
      if (others.length) appendEntry(card, others.length === entry.faixas.length ? entry : { id: entry.id, titulo: '📁 ' + folder.name + ' (outros arquivos)', formato: 'local', faixas: others, local: true });
      else card.appendChild(el('div', 'pl-head', '<span class="pl-title">📁 ' + esc(folder.name) + '</span><span class="pl-meta">os downloads são gravados aqui</span>'));
      var tools = el('div', 'folder-tools');
      if (entry.faixas.length && fitaInfo.nivelar) {
        var busy = jobRunning();
        // Tudo vai para uma pasta só, "rebobina": cada música tem lá um arquivo, atualizado no lugar (os originais ficam).
        var both = el('button', 'retry', '🔊✏️ Nivelar e padronizar'); both.type = 'button'; both.disabled = busy;
        both.title = 'As duas coisas de uma vez: volume nivelado e nome "Título - Artista" com etiquetas, na pasta "rebobina"';
        both.onclick = function () { processFolder('ambos'); };
        var level = el('button', 'retry', '🔊 Nivelar'); level.type = 'button'; level.disabled = busy;
        level.title = 'Nivela o volume a partir dos originais e atualiza a música na pasta "rebobina" (se já estava padronizada, continua com o nome certo)';
        level.onclick = function () { processFolder('nivelar'); };
        var rename = el('button', 'retry', '✏️ Padronizar nomes'); rename.type = 'button'; rename.disabled = busy;
        rename.title = '"Título - Artista", sem "(2)" nem "(Official Video)", com as etiquetas: renomeia os arquivos da pasta "rebobina" no lugar (o volume nivelado fica)';
        rename.onclick = function () { processFolder('padronizar'); };
        var analyze = el('button', 'retry', '📊 Analisar volume'); analyze.type = 'button'; analyze.disabled = busy;
        analyze.title = 'Só mede o volume de cada música (como o MP3Gain): mostra quais estão baixas ou altas, sem alterar nada';
        analyze.onclick = analyzeFolder;
        tools.appendChild(both); tools.appendChild(level); tools.appendChild(rename); tools.appendChild(analyze);
      }
      var rescan = el('button', 'retry', '↻ Reler'); rescan.type = 'button'; rescan.onclick = function () { scanFolder(); };
      var change = el('button', 'retry', 'Trocar pasta'); change.type = 'button'; change.onclick = pickFolder;
      var forget = el('button', 'retry', 'Esquecer'); forget.type = 'button'; forget.onclick = forgetFolder;
      tools.appendChild(rescan); tools.appendChild(change); tools.appendChild(forget);
      card.appendChild(tools);
    }
    var status = el('div', 'folder-status'); status.id = 'folder-status'; status.textContent = folder ? folder.status : '';
    card.appendChild(status);
    // O painel da tarefa (lista das músicas e barra) é o mesmo elemento a cada redesenho: nada se perde.
    if (lib.job) card.appendChild(lib.job.el);
    if (folder && folder.granted && lib.outEntry) appendEntry(card, lib.outEntry);
    box.appendChild(card);
  }

  function renderLibrary() {
    var box = $('lib-list');
    box.innerHTML = '';
    renderFolder(box);
    if (!lib.list.length) { box.appendChild(el('div', 'lib-empty', 'Nenhuma playlist baixada ainda. Mande um link do YouTube no chat.')); return; }
    lib.list.forEach(function (entry) {
      var pl = el('div', 'pl');
      appendEntry(pl, entry);
      box.appendChild(pl);
    });
  }

  /** Cabeçalho, botões, falhas e faixas de uma playlist (baixada ou da pasta local). */
  function appendEntry(pl, entry) {
      var head = el('div', 'pl-head');
      var open = el('button', 'pl-open');
      open.type = 'button';
      var meta = entry.faixas.length + ' faixa(s) · ' + (entry.local ? 'no seu computador' : (FORMAT_LABEL[entry.formato] || entry.formato)) + (entry.nivelada ? ' · 🔊 nivelada' : '');
      open.innerHTML = '<span class="pl-title">' + esc(entry.titulo) + '</span><span class="pl-meta">' + meta + '</span>';
      open.onclick = function () { lib.open[entry.id] = !lib.open[entry.id]; renderLibrary(); };
      var play = el('button', 'mini', '▶'); play.type = 'button'; play.title = 'Tocar tudo';
      play.onclick = function () { playEntry(entry, 0); };
      var del = el('button', 'mini', '✕'); del.type = 'button'; del.title = 'Tirar da biblioteca (os arquivos continuam no computador)';
      del.onclick = function () {
        api('/api/x/biblioteca/' + entry.id, { method: 'DELETE' }).then(loadLibrary).catch(function () {});
      };
      head.appendChild(open);
      if (entry.faixas.length) head.appendChild(play);
      if (!entry.local && entry.faixas.length) {
        // A playlist inteira de uma vez: .zip (qualquer navegador) ou na pasta escolhida (Chrome/Edge em localhost).
        var zip = el('a', 'mini', '⬇️'); zip.title = 'Baixar a playlist inteira (.zip)';
        zip.href = fileUrl('/api/x/biblioteca/' + entry.id + '/zip'); zip.setAttribute('download', '');
        head.appendChild(zip);
        if (canPickFolder) {
          var folder = el('button', 'mini', '📁'); folder.type = 'button';
          folder.title = lib.folder && lib.folder.granted ? 'Gravar a playlist inteira na pasta "' + lib.folder.name + '"' : 'Gravar a playlist inteira numa pasta';
          folder.onclick = function () {
            if (lib.folder && lib.folder.granted) { lib.forceSave[entry.id] = true; autoSave(); return; }
            var status = el('div', 'lib-empty'); pl.appendChild(status);
            saveToFolder(entry.faixas.map(function (t) { return { url: t.url, nome: t.arquivo }; }), status);
          };
          head.appendChild(folder);
        }
        if (fitaInfo.nivelar && !entry.nivelada) {
          var level = el('button', 'mini', '🔊'); level.type = 'button'; level.title = 'Nivelar o volume de todas as faixas';
          level.onclick = function () { levelEntry(entry, level); };
          head.appendChild(level);
        }
      }
      if (!entry.local) head.appendChild(del);
      pl.appendChild(head);
      if ((entry.falhas || []).length) {
        var fails = el('div', 'fails');
        var summary = el('button', 'fails-head');
        summary.type = 'button';
        summary.textContent = '⚠️ ' + entry.falhas.length + ' não baixaram' + (lib.failsOpen[entry.id] ? ' ▴' : ' ▾');
        summary.onclick = function () { lib.failsOpen[entry.id] = !lib.failsOpen[entry.id]; renderLibrary(); };
        var retry = el('button', 'retry', '↻ Tentar de novo');
        retry.type = 'button';
        retry.onclick = function () { retryFailed(entry, retry); };
        var row = el('div', 'fails-row'); row.appendChild(summary); row.appendChild(retry); fails.appendChild(row);
        if (lib.failsOpen[entry.id]) {
          entry.falhas.forEach(function (f) {
            var item = el('div', 'fail');
            item.innerHTML = (f.link ? '<a href="' + esc(f.link) + '" target="_blank" rel="noopener noreferrer">' + esc(f.link) + '</a>' : '(sem link)') + ' <span>' + esc(f.motivo) + '</span>';
            fails.appendChild(item);
          });
        }
        pl.appendChild(fails);
      }
      if (lib.open[entry.id]) {
        var tracks = el('div', 'tracks');
        entry.faixas.forEach(function (track, i) {
          var row = el('button', 'track');
          row.type = 'button';
          row.innerHTML = '<span class="n">' + (i + 1) + '</span><span class="t">' + esc(track.nome) + '</span>';
          if (lib.entryId === entry.id && lib.order[lib.pos] === i) row.classList.add('playing');
          row.onclick = function () { playEntry(entry, i); };
          tracks.appendChild(row);
        });
        pl.appendChild(tracks);
      }
  }

  function media() { return lib.video ? $('p-video') : $('p-audio'); }
  function entryById(id) {
    if (id === 'pasta-local') return lib.localEntry;
    if (id === 'preview') return lib.preview;
    if (id === 'pasta-rebobina') return lib.outEntry;
    return lib.list.filter(function (e) { return e.id === id; })[0];
  }

  /** Toca a playlist a partir da faixa `start` (com embaralhar ligado, a ordem é sorteada e a escolhida vem primeiro). */
  function playEntry(entry, start) {
    lib.queue = entry.faixas; lib.entryId = entry.id;
    lib.order = entry.faixas.map(function (_, i) { return i; });
    if (lib.shuffle) {
      for (var i = lib.order.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var tmp = lib.order[i]; lib.order[i] = lib.order[j]; lib.order[j] = tmp; }
      lib.order.splice(lib.order.indexOf(start), 1); lib.order.unshift(start);
      lib.pos = 0;
    } else lib.pos = start;
    lib.open[entry.id] = true;
    $('player').classList.remove('hidden');
    playCurrent();
  }

  function playCurrent() {
    var track = lib.queue[lib.order[lib.pos]];
    if (!track) return;
    // Áudio ou vídeo por faixa (a pasta do computador pode misturar os dois).
    lib.video = VIDEO_FILE.test(track.arquivo || '');
    $('p-audio').classList.toggle('hidden', lib.video); $('p-video').classList.toggle('hidden', !lib.video);
    (lib.video ? $('p-audio') : $('p-video')).pause();
    var player = media();
    if (lib.blobUrl) { URL.revokeObjectURL(lib.blobUrl); lib.blobUrl = null; }
    // Da pasta local: toca direto do computador (nada é enviado ao servidor).
    var source = track.handle
      ? track.handle.getFile().then(function (file) { lib.blobUrl = URL.createObjectURL(file); return lib.blobUrl; })
      : Promise.resolve(fileUrl(track.url));
    source.then(function (src) { player.src = src; return player.play(); }).catch(function () {});
    var entry = entryById(lib.entryId);
    $('player-title').innerHTML = esc(track.nome) + (entry ? ' <small>· ' + esc(entry.titulo) + ' · ' + (lib.pos + 1) + '/' + lib.queue.length + '</small>' : '');
    document.title = '▶ ' + track.nome;
    renderLibrary();
  }

  function step(delta) {
    if (!lib.queue.length) return;
    var next = lib.pos + delta;
    if (next < 0 || next >= lib.order.length) return;
    lib.pos = next; playCurrent();
  }
  $('p-prev').onclick = function () { if (media().currentTime > 3) media().currentTime = 0; else step(-1); };
  $('p-next').onclick = function () { step(1); };
  $('p-shuffle').onclick = function () {
    lib.shuffle = !lib.shuffle;
    $('p-shuffle').classList.toggle('on', lib.shuffle);
    // Reorganiza só o resto da fila: a faixa atual continua tocando de onde está.
    if (lib.pos < 0) return;
    var current = lib.order[lib.pos];
    var rest = lib.queue.map(function (_, i) { return i; }).filter(function (i) { return i !== current; });
    if (lib.shuffle) for (var i = rest.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var tmp = rest[i]; rest[i] = rest[j]; rest[j] = tmp; }
    lib.order = lib.shuffle ? [current].concat(rest) : lib.queue.map(function (_, i) { return i; });
    lib.pos = lib.shuffle ? 0 : current;
    renderLibrary();
  };
  $('p-audio').onended = $('p-video').onended = function () { step(1); };
  $('p-close').onclick = function () {
    $('p-audio').pause(); $('p-video').pause(); $('player').classList.add('hidden');
    lib.entryId = null; lib.pos = -1; document.title = K7.state.info ? K7.state.info.nome : 'K7'; renderLibrary();
  };

  // ── YouTube dentro do painel: procurar, ouvir antes, abrir playlists e baixar o que marcar ──────────────
  // Sem copiar e colar links: a busca usa o serviço da fita (yt-dlp) e o vídeo toca no player do YouTube sem cookies.
  $('lib-toggle').insertAdjacentHTML('beforebegin', '<button id="yt-toggle" class="hidden" type="button" title="Procurar no YouTube e escolher o que baixar">▶️ YouTube</button>');
  $('main').insertAdjacentHTML('afterend',
    '<aside id="yt" class="hidden" aria-label="YouTube">' +
    '  <div id="yt-head">▶️ YouTube <button type="button" id="yt-close" title="Fechar">✕</button></div>' +
    '  <form id="yt-form" autocomplete="off">' +
    '    <input id="yt-q" type="search" placeholder="Música, artista ou link de playlist" aria-label="O que procurar">' +
    '    <div id="yt-kind" role="radiogroup">' +
    '      <label><input type="radio" name="yt-kind" value="video" checked> Vídeos</label>' +
    '      <label><input type="radio" name="yt-kind" value="playlist"> Playlists</label>' +
    '      <button type="submit" id="yt-go">Procurar</button>' +
    '    </div>' +
    '  </form>' +
    '  <div id="yt-results"><div class="lib-empty">Procure uma música, um artista ou cole o link de uma playlist. Marque o que quiser e baixe tudo de uma vez.</div></div>' +
    '  <div id="yt-basket" class="hidden">' +
    '    <div id="yt-count"></div>' +
    '    <div id="yt-actions">' +
    '      <select id="yt-format" aria-label="Formato"><option value="mp3">MP3</option><option value="wav">WAV</option><option value="mp4">Vídeo</option></select>' +
    '      <button type="button" id="yt-clear">Limpar</button>' +
    '      <button type="button" id="yt-download">⬇️ Baixar</button>' +
    '    </div>' +
    '    <div id="yt-status"></div>' +
    '  </div>' +
    '</aside>');

  var yt = { videos: {}, playlists: {}, view: null, busy: false };
  var PLAYLIST_LINK = /^https?:\/\/(?:(?:www|m|music)\.)?youtube\.com\/.*[?&]list=([\w-]+)/i;
  var VIDEO_LINK = /^https?:\/\/(?:(?:www|m|music)\.)?(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/)|youtu\.be\/)([\w-]{11})/i;
  var WHOLE_ON = '✓ Inteira marcada', WHOLE_OFF = '＋ Playlist inteira';

  function setYtOpen(open) {
    $('yt').classList.toggle('hidden', !open);
    $('yt-toggle').classList.toggle('on', open);
    if (open) $('yt-q').focus();
  }
  $('yt-toggle').onclick = function () { setYtOpen($('yt').classList.contains('hidden')); };
  $('yt-close').onclick = function () { setYtOpen(false); };

  function clock(secs) {
    if (!secs) return '';
    var h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = ('0' + (secs % 60)).slice(-2);
    return h ? h + ':' + ('0' + m).slice(-2) + ':' + s : m + ':' + s;
  }
  function thumb(id) { return 'https://i.ytimg.com/vi/' + encodeURIComponent(id) + '/mqdefault.jpg'; }
  function message(text) { $('yt-results').innerHTML = ''; $('yt-results').appendChild(el('div', 'lib-empty', esc(text))); }
  function eachIn(selector, fn) { Array.prototype.forEach.call($('yt-results').querySelectorAll(selector), fn); }

  function renderBasket() {
    var v = Object.keys(yt.videos).length, p = Object.keys(yt.playlists).length;
    $('yt-basket').classList.toggle('hidden', !v && !p && !yt.busy && !$('yt-status').textContent);
    var parts = [];
    if (v) parts.push(v + (v === 1 ? ' vídeo' : ' vídeos'));
    if (p) parts.push(p + (p === 1 ? ' playlist inteira' : ' playlists inteiras'));
    $('yt-count').textContent = parts.length ? 'Marcados: ' + parts.join(' e ') : 'Nada marcado';
    $('yt-download').disabled = yt.busy || (!v && !p);
    $('yt-clear').disabled = yt.busy || (!v && !p);
  }

  function wholeButton(link, name) {
    var b = el('button', 'yt-mini'); b.type = 'button';
    b.title = 'Baixa a playlist toda, como uma playlist própria na biblioteca';
    function paint() { b.textContent = yt.playlists[link] ? WHOLE_ON : WHOLE_OFF; b.classList.toggle('on', !!yt.playlists[link]); }
    b.onclick = function () {
      if (yt.playlists[link]) delete yt.playlists[link]; else yt.playlists[link] = name || link;
      paint(); renderBasket();
    };
    paint();
    return b;
  }

  /** Linha de um vídeo: miniatura (toca o vídeo ali mesmo), título, canal · duração e a caixa de marcar. */
  function videoRow(video) {
    var row = el('div', 'yt-row');
    var pic = el('button', 'yt-thumb'); pic.type = 'button'; pic.title = 'Ver o vídeo aqui';
    pic.innerHTML = '<img loading="lazy" alt="" src="' + esc(thumb(video.id)) + '"><span>▶</span>';
    var info = el('label', 'yt-info');
    var box = document.createElement('input'); box.type = 'checkbox'; box.checked = !!yt.videos[video.link];
    box.onchange = function () { if (box.checked) yt.videos[video.link] = video.titulo; else delete yt.videos[video.link]; renderBasket(); };
    var text = el('span', 'yt-text', '<b>' + esc(video.titulo || video.link) + '</b><small>' + esc([video.canal, clock(video.duracao)].filter(Boolean).join(' · ')) + '</small>');
    info.appendChild(box); info.appendChild(text);
    row.appendChild(pic); row.appendChild(info);
    pic.onclick = function () {
      var open = row.querySelector('.yt-embed');
      if (open) { open.remove(); row.querySelector('.yt-out').remove(); return; }
      var frame = document.createElement('iframe');
      frame.className = 'yt-embed';
      frame.src = 'https://www.youtube-nocookie.com/embed/' + encodeURIComponent(video.id) + '?autoplay=1&rel=0';
      frame.allow = 'autoplay; encrypted-media; picture-in-picture';
      frame.allowFullscreen = true;
      // O player do YouTube não toca sem saber de qual site veio (a página do chat não manda referência por padrão).
      frame.referrerPolicy = 'strict-origin-when-cross-origin';
      frame.title = video.titulo || 'Vídeo';
      row.appendChild(frame);
      // Alguns donos não deixam o vídeo tocar fora do YouTube: o link abre lá.
      var out = el('a', 'yt-out', 'Não tocou aqui? Abrir no YouTube ↗');
      out.href = 'https://www.youtube.com/watch?v=' + encodeURIComponent(video.id); out.target = '_blank'; out.rel = 'noopener';
      row.appendChild(out);
    };
    return row;
  }

  /** Linha de uma playlist: abrir para escolher as músicas, ou marcar a playlist inteira. */
  function playlistRow(pl) {
    var row = el('div', 'yt-row');
    var pic = el('div', 'yt-thumb yt-pl', pl.capa ? '<img loading="lazy" alt="" src="' + esc(pl.capa) + '"><span>☰</span>' : '<span>☰</span>');
    var info = el('div', 'yt-info');
    info.appendChild(el('span', 'yt-text', '<b>' + esc(pl.titulo || 'Playlist') + '</b><small>' + esc(pl.canal || '') + '</small>'));
    var tools = el('div', 'yt-tools');
    var see = el('button', 'yt-mini', 'Escolher músicas'); see.type = 'button';
    see.onclick = function () { openPlaylist(pl.link, pl.titulo); };
    tools.appendChild(see); tools.appendChild(wholeButton(pl.link, pl.titulo));
    info.appendChild(tools);
    row.appendChild(pic); row.appendChild(info);
    return row;
  }

  function showVideos(videos, header) {
    var box = $('yt-results'); box.innerHTML = '';
    if (header) box.appendChild(header);
    if (!videos.length) { box.appendChild(el('div', 'lib-empty', 'Nada encontrado.')); return; }
    videos.forEach(function (v) { box.appendChild(videoRow(v)); });
  }
  function showPlaylists(playlists) {
    var box = $('yt-results'); box.innerHTML = '';
    if (!playlists.length) return message('Nenhuma playlist encontrada.');
    playlists.forEach(function (pl) { box.appendChild(playlistRow(pl)); });
  }
  function showView(view) {
    if (view.kind === 'playlist') showPlaylists(view.data.playlists || []); else showVideos(view.data.videos || []);
  }

  function search(event) {
    if (event) event.preventDefault();
    var q = $('yt-q').value.trim();
    if (!q) return;
    var list = PLAYLIST_LINK.exec(q), video = VIDEO_LINK.exec(q);
    if (list && !video) return openPlaylist(q, '');
    if (video) return showVideos([{ id: video[1], titulo: q, canal: '', duracao: null, link: 'https://youtu.be/' + video[1] }]);
    var kind = document.querySelector('input[name="yt-kind"]:checked').value;
    message('🔎 Procurando…');
    $('yt-go').disabled = true;
    api('/api/x/youtube/pesquisar?tipo=' + kind + '&q=' + encodeURIComponent(q))
      .then(function (r) { yt.view = { kind: kind, data: r }; showView(yt.view); })
      .catch(function (err) { message('⚠️ ' + err.message); })
      .then(function () { $('yt-go').disabled = false; });
  }
  $('yt-form').onsubmit = search;

  /** Músicas de uma playlist com caixas de marcar (marcar todos / desmarcar) e o atalho "playlist inteira". */
  function openPlaylist(link, title) {
    var back = yt.view;
    message('☰ Abrindo a playlist…');
    api('/api/x/youtube/playlist?url=' + encodeURIComponent(link)).then(function (r) {
      var name = r.titulo || title || 'Playlist';
      var head = el('div', 'yt-plhead');
      var top = el('div', 'yt-plrow');
      if (back) {
        var ret = el('button', 'yt-mini', '← Resultados'); ret.type = 'button';
        ret.onclick = function () { yt.view = back; showView(back); };
        top.appendChild(ret);
      }
      top.appendChild(el('b', '', esc(name) + ' <small>· ' + r.videos.length + ' vídeos</small>'));
      head.appendChild(top);
      var tools = el('div', 'yt-plrow');
      var all = el('button', 'yt-mini', 'Marcar todos'); all.type = 'button';
      var none = el('button', 'yt-mini', 'Desmarcar'); none.type = 'button';
      function mark(on) {
        r.videos.forEach(function (v) { if (on) yt.videos[v.link] = v.titulo; else delete yt.videos[v.link]; });
        eachIn('.yt-row input[type=checkbox]', function (b) { b.checked = on; });
        renderBasket();
      }
      all.onclick = function () { mark(true); };
      none.onclick = function () { mark(false); };
      tools.appendChild(all); tools.appendChild(none); tools.appendChild(wholeButton(link, name));
      head.appendChild(tools);
      showVideos(r.videos, head);
    }).catch(function (err) { message('⚠️ ' + err.message); });
  }

  function clearMarks() {
    yt.videos = {}; yt.playlists = {};
    eachIn('input[type=checkbox]', function (b) { b.checked = false; });
    eachIn('.yt-mini.on', function (b) { b.classList.remove('on'); b.textContent = WHOLE_OFF; });
  }
  $('yt-clear').onclick = function () { clearMarks(); $('yt-status').textContent = ''; renderBasket(); };

  /** Baixa tudo que está marcado direto no serviço (sem passar pelo modelo); a biblioteca mostra chegando. */
  $('yt-download').onclick = function () {
    var links = Object.keys(yt.videos), playlists = Object.keys(yt.playlists);
    if (!links.length && !playlists.length) return;
    yt.busy = true; renderBasket();
    $('yt-status').textContent = '⬇️ Começando…';
    // A playlist que surgir abre sozinha na biblioteca (como nos downloads pelo chat).
    lib.snapshot = {};
    lib.list.forEach(function (entry) { lib.snapshot[entry.id] = entry.criadoEm; });
    setLibOpen(true);
    var tick = setInterval(function () {
      api('/api/progresso').then(function (p) {
        if (p && p.texto) $('yt-status').textContent = p.texto + (p.total ? ' ' + Math.min(100, Math.round((p.feitos / p.total) * 100)) + '%' : '');
      }).catch(function () {});
      loadLibrary();
    }, 3000);
    api('/api/x/baixar', { method: 'POST', body: { links: links, playlists: playlists, formato: $('yt-format').value } })
      .then(function (r) {
        if (!r.ok) { $('yt-status').textContent = '⚠️ ' + (r.erro || 'Não consegui baixar.'); return; }
        var text = '✅ ' + r.arquivos + ' arquivo(s) na biblioteca';
        if (r.reaproveitados) text += ' (' + r.reaproveitados + ' já tinham sido baixados)';
        if (r.alternativas) text += '. ' + r.alternativas + ' vieram de outro vídeo da mesma música';
        if (r.falhas.length) text += '. ' + r.falhas.length + ' não baixaram: veja na playlist da biblioteca';
        $('yt-status').textContent = text + '.';
        clearMarks();
      })
      .catch(function (err) { $('yt-status').textContent = '⚠️ ' + err.message; })
      .then(function () { clearInterval(tick); yt.busy = false; renderBasket(); loadLibrary(); });
  };

  // ── Início ────────────────────────────────────────────────────────────────
  K7.onReady(function () {
    api('/api/x/info').then(function (info) {
      fitaInfo = info || {};
      $('lib-toggle').classList.remove('hidden');
      $('yt-toggle').classList.remove('hidden');
      var saved = null; try { saved = localStorage.getItem('libOpen'); } catch (e) {}
      // Aberta por padrão em tela larga; no celular, só quando a pessoa toca no botão.
      setLibOpen(saved ? saved === '1' : matchMedia('(min-width: 1100px)').matches);
      return restoreFolder().then(loadLibrary);
    }).catch(function () {});
  });
  // Biblioteca cresce enquanto baixa; recarrega quando chegam arquivos na resposta.
  var poll = null;
  K7.onBusy(function (busy) {
    if (busy && !poll) {
      lib.snapshot = {};
      lib.list.forEach(function (entry) { lib.snapshot[entry.id] = entry.criadoEm; });
      poll = setInterval(loadLibrary, 5000);
    }
    if (!busy && poll) { clearInterval(poll); poll = null; }
  });
  K7.onReply(function (reply) { if ((reply.arquivos || []).length) loadLibrary(); });
})();
