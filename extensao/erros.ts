/**
 * Erro com uma mensagem para a pessoa ler: o K7 mostra `userMessage` como está, no chat e na página
 * (qualquer erro com `userMessage` em texto vale; esta fita não depende do código do tocador).
 */
export class UserFacingError extends Error {
  constructor(
    public readonly userMessage: string,
    technicalMessage?: string,
    options?: { cause?: unknown },
  ) {
    super(technicalMessage ?? userMessage, options);
    this.name = new.target.name;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** O que mostrar à pessoa: a mensagem amigável, se houver, ou a técnica. */
export function userMessage(error: unknown): string {
  return error instanceof UserFacingError ? error.userMessage : errorMessage(error);
}
