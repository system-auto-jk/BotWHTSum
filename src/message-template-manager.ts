import * as fs from 'fs';
import * as path from 'path';

export type MessageTemplateMap = Record<string, string>;

export interface MessageTemplateMeta {
  key: string;
  label: string;
  description: string;
  placeholders?: string[];
}

interface MessageTemplatesFile {
  templates: MessageTemplateMap;
}

const DEFAULT_TEMPLATES: MessageTemplateMap = {
  botDisabledByAdmin: 'BOT DESATIVADO COM SUCESSO!\n\nO bot nao respondera ate ser reativado.\n\nUse !startbot para ativar novamente.',
  botAlreadyDisabled: 'O bot ja esta desativado.',
  botEnabledByAdmin: 'BOT ATIVADO COM SUCESSO!\n\nO bot esta operacional novamente e respondendo normalmente.',
  botAlreadyEnabled: 'O bot ja esta ativado.',
  genericRequestError: 'Houve um erro ao processar sua solicitacao. Tente novamente mais tarde.',
  genericRequestErrorShort: 'Houve um erro ao processar sua solicitacao. Tente novamente.',
  humanConnectedDefault: 'Voce foi conectado a um atendente. Um de nossos especialistas em breve respondera sua mensagem!',
  humanConnectedFromRegistration: 'Voce foi conectado a um atendente. Aguarde a resposta.',
  humanForwardingNamed: 'Perfeito! Seu atendimento esta sendo transferido para {attendantName}.',
  queuePendingFallback: 'Seu pedido de atendimento ja foi registrado. Aguarde que nossa equipe vai falar com voce por aqui.',
  queueExitToMenu: 'Voce saiu da fila de atendimento e voltou ao menu principal.',
  attendancePendingFallback: 'Seu atendimento humano continua em andamento. Aguarde a resposta da equipe.\n\nSe quiser voltar ao menu principal, digite: menu',
  attendanceEndedByClient: 'Atendimento finalizado. Voltando ao menu principal...',
  attendanceEndedDefault: 'Atendimento finalizado. O bot foi reativado para responder automaticamente.',
  queueRemovedByAdmin: 'Voce foi removido da fila de espera.',
  queueAssignedByAttendant: 'Seu atendimento foi iniciado com {attendantName}.',
  queueAssignedPullNext: 'Voce saiu da fila e seu atendimento foi iniciado com {attendantName}.'
};

const TEMPLATE_CATALOG: MessageTemplateMeta[] = [
  { key: 'botDisabledByAdmin', label: 'Bot desativado (admin)', description: 'Retorno para o administrador no WhatsApp ao usar !stopbot.' },
  { key: 'botAlreadyDisabled', label: 'Bot ja desativado', description: 'Retorno quando o bot ja estava desativado.' },
  { key: 'botEnabledByAdmin', label: 'Bot ativado (admin)', description: 'Retorno para o administrador no WhatsApp ao usar !startbot.' },
  { key: 'botAlreadyEnabled', label: 'Bot ja ativado', description: 'Retorno quando o bot ja estava ativado.' },
  { key: 'genericRequestError', label: 'Erro generico', description: 'Mensagem padrao de falha em fluxos principais.' },
  { key: 'genericRequestErrorShort', label: 'Erro generico curto', description: 'Fallback curto para falhas rapidas.' },
  { key: 'humanConnectedDefault', label: 'Conectado ao atendente', description: 'Quando o cliente e conectado ao atendente no fluxo geral.' },
  { key: 'humanConnectedFromRegistration', label: 'Conectado no cadastro', description: 'Quando o cliente e conectado ao atendente durante cadastro.' },
  { key: 'humanForwardingNamed', label: 'Transferindo para atendente', description: 'Mensagem com nome do atendente.', placeholders: ['{attendantName}'] },
  { key: 'queuePendingFallback', label: 'Fila aguardando atendimento', description: 'Quando o cliente pediu atendimento e a equipe ainda vai assumir.' },
  { key: 'queueExitToMenu', label: 'Saiu da fila', description: 'Quando cliente digita menu e sai da fila.' },
  { key: 'attendancePendingFallback', label: 'Atendimento em andamento', description: 'Quando o cliente ainda esta em contexto humano e continua aguardando resposta.' },
  { key: 'attendanceEndedByClient', label: 'Finalizacao pelo cliente', description: 'Quando cliente encerra atendimento e volta ao menu.' },
  { key: 'attendanceEndedDefault', label: 'Finalizacao padrao', description: 'Quando sessao e encerrada sem mensagem custom.' },
  { key: 'queueRemovedByAdmin', label: 'Removido da fila', description: 'Quando admin remove cliente da fila.' },
  { key: 'queueAssignedByAttendant', label: 'Fila iniciada por atendente', description: 'Quando atendente escolhe cliente na fila.', placeholders: ['{attendantName}'] },
  { key: 'queueAssignedPullNext', label: 'Fila proximo (pull next)', description: 'Quando atendente puxa proximo da fila.', placeholders: ['{attendantName}'] }
];

export class MessageTemplateManager {
  private readonly filePath: string;
  private templates: MessageTemplateMap = { ...DEFAULT_TEMPLATES };

  constructor(filePath?: string) {
    this.filePath = filePath || path.join(__dirname, '../config/message-templates.json');
    this.loadFromFile();
  }

  private loadFromFile() {
    try {
      if (!fs.existsSync(this.filePath)) {
        this.saveToFile();
        return;
      }
      const raw = fs.readFileSync(this.filePath, 'utf-8').replace(/^\uFEFF/, '');
      const parsed = JSON.parse(raw) as Partial<MessageTemplatesFile>;
      const incoming = parsed && parsed.templates && typeof parsed.templates === 'object'
        ? parsed.templates
        : {};
      this.templates = { ...DEFAULT_TEMPLATES, ...incoming };
    } catch (error) {
      console.error('Erro ao carregar templates de mensagem:', error);
      this.templates = { ...DEFAULT_TEMPLATES };
    }
  }

  private saveToFile() {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const payload: MessageTemplatesFile = { templates: this.templates };
      fs.writeFileSync(this.filePath, JSON.stringify(payload, null, 2));
    } catch (error) {
      console.error('Erro ao salvar templates de mensagem:', error);
    }
  }

  public getAll() {
    return {
      templates: { ...this.templates },
      catalog: TEMPLATE_CATALOG
    };
  }

  public get(key: string, fallback?: string): string {
    const value = this.templates[key];
    if (typeof value === 'string' && value.trim()) return value;
    if (typeof fallback === 'string') return fallback;
    return '';
  }

  public render(key: string, variables?: Record<string, string | number>, fallback?: string): string {
    const template = this.get(key, fallback);
    if (!variables) return template;
    return template.replace(/\{(\w+)\}/g, (_match, token: string) => {
      const value = variables[token];
      return value === undefined || value === null ? '' : String(value);
    });
  }

  public updateMany(next: Record<string, string>) {
    if (!next || typeof next !== 'object') return this.getAll();
    let changed = false;
    for (const [key, value] of Object.entries(next)) {
      if (typeof value !== 'string') continue;
      const normalized = value.replace(/\r\n/g, '\n').trim();
      if (!normalized) continue;
      this.templates[key] = normalized;
      changed = true;
    }
    if (changed) this.saveToFile();
    return this.getAll();
  }
}
