import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FitaApi, FitaTool, WebRotaCtx } from '../extensao/k7.js';

interface Rota {
  metodo: string;
  caminho: RegExp;
  visitante: boolean;
  handler: (ctx: WebRotaCtx) => Promise<void> | void;
}

/** Visitante como o K7 vê: o identificador do navegador vira hash. */
export const dono = (visitante: string) => `web-${createHash('sha256').update(visitante).digest('hex').slice(0, 16)}`;

/**
 * K7 de mentira para testar a fita sem o tocador: guarda o que a extensão registra e serve as rotas num
 * servidor HTTP com o mesmo contrato do chat web (visitante no cabeçalho X-Visitante, erros com status e mensagem).
 */
export class K7Falso {
  readonly rotas: Rota[] = [];
  readonly ferramentas: FitaTool[] = [];
  readonly progresso = new Map<string, { texto: string; contagem?: { done: number; total: number } }>();
  painel?: { script?: string; estilo?: string };
  private server?: http.Server;

  constructor(private readonly dirs: { dir?: string; workspaceDir?: string } = {}) {}

  api(env: Record<string, string> = {}): FitaApi {
    return {
      fita: { nome: 'rebobina', dir: this.dirs.dir ?? '.', workspaceDir: this.dirs.workspaceDir ?? '.', dadosDir: '.', env },
      log: { info: () => undefined, aviso: () => undefined, erro: () => undefined },
      ferramenta: (tool) => void this.ferramentas.push(tool),
      web: {
        rota: (metodo, caminho, handler, opcoes = {}) => void this.rotas.push({ metodo, caminho, visitante: opcoes.visitante !== false, handler }),
        painel: (arquivos) => void (this.painel = arquivos),
      },
      comando: () => undefined,
      aoIniciar: () => undefined,
      util: {
        limitador: () => ({ run: (_chave, tarefa) => tarefa() }),
        emParalelo: (itens, _max, tarefa) => Promise.all(itens.map(tarefa)),
      },
      processoPrincipal: false,
      tarefa: () => undefined,
      sql: { exec: () => undefined, run: () => ({ changes: 0, lastInsertRowid: 0 }), get: () => undefined, all: () => [], transacao: (fn) => fn() },
      telegram: {
        comando: () => undefined,
        aoLocalizacao: () => undefined,
        botoes: () => undefined,
        notificar: async () => ({ entregue: false, erro: 'sem Telegram nos testes' }),
        acessos: { listar: () => [], definir: () => false, convite: async () => Promise.reject(new Error('sem Telegram nos testes')) },
      },
    };
  }

  async ouvir(): Promise<string> {
    this.server = http.createServer((req, res) => void this.atender(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  fechar(): Promise<void> {
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private async atender(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://local');
    const json = (dados: unknown, status = 200): void => void res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(dados));
    try {
      const rota = this.rotas.find((r) => r.metodo === req.method && r.caminho.test(url.pathname));
      if (!rota) return json({ erro: 'Não encontrado' }, 404);
      const visitante = String(req.headers['x-visitante'] ?? '');
      if (rota.visitante && !visitante) return json({ erro: 'Visitante não identificado' }, 400);
      const userId = rota.visitante ? dono(visitante) : '';
      const saiu = new AbortController();
      res.once('close', () => !res.writableFinished && saiu.abort());
      await rota.handler({
        req,
        res,
        url,
        params: rota.caminho.exec(url.pathname)!.slice(1),
        userId,
        publico: true,
        saiu: saiu.signal,
        json,
        midia: (arquivo, nome) => void res.writeHead(200, { 'x-nome': encodeURIComponent(nome) }).end(fs.readFileSync(arquivo)),
        zip: async (arquivos, nome) => void res.writeHead(200, { 'content-disposition': `attachment; filename="${nome}"` }).end(`PK ${arquivos.map((a) => a.name).join(',')}`),
        lerJson: async () => ({}),
        falhar: (status, mensagem) => {
          throw Object.assign(new Error(mensagem), { status });
        },
        emFila: (tarefa) => tarefa(),
        progresso: (texto, contagem) => void this.progresso.set(userId, { texto, ...(contagem ? { contagem } : {}) }),
        limparProgresso: () => void this.progresso.delete(userId),
      });
    } catch (error) {
      const { status, userMessage, message } = error as { status?: number; userMessage?: string; message: string };
      if (!res.headersSent) json({ erro: userMessage ?? message }, status ?? (userMessage ? 422 : 500));
      else res.destroy();
    }
  }
}
