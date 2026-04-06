import type { WASocket } from 'baileys';
import * as fs from 'fs';
import * as path from 'path';
import MenuManager from './menu-manager';

export type QueuePriority = 'low' | 'normal' | 'high' | 'urgent';

export interface Attendant {
  id: string;
  name: string;
  email: string;
  login: string;
  password: string;
  status: 'online' | 'offline' | 'busy';
  lastSeenAt: number;
  activeChats: string[];
  createdAt: number;
  skills: string[];
  maxConcurrentChats: number;
}

export interface AttendanceMessage {
  type: 'client' | 'attendant' | 'bot';
  text: string;
  timestamp: number;
}

export interface SessionHandoffContext {
  priority: QueuePriority;
  requestedSkill?: string;
  reason?: string;
  summary?: string;
  tags?: string[];
  queuedAt?: number;
  assignedAt: number;
  queueWaitSeconds?: number;
}

export interface SessionMetrics {
  firstClientMessageAt?: number;
  firstAttendantReplyAt?: number;
  firstResponseSeconds?: number;
  queueWaitSeconds?: number;
  totalMessages: number;
}

export interface AttendanceSession {
  sessionId: string;
  clientJid: string;
  attendantId: string;
  startTime: number;
  endTime?: number;
  isActive: boolean;
  botEnabled: boolean;
  messages: AttendanceMessage[];
  handoff: SessionHandoffContext;
  metrics: SessionMetrics;
}

export interface QueuedClient {
  clientJid: string;
  clientName: string;
  queuedAt: number;
  estimatedPosition?: number;
  priority: QueuePriority;
  requestedSkill?: string;
  reason?: string;
  summary?: string;
  tags?: string[];
}

export interface AttendanceMacro {
  id: string;
  title: string;
  text: string;
  category?: string;
  approved: boolean;
  version: number;
  updatedAt: number;
  updatedBy?: string;
}

export interface SessionReview {
  sessionId: string;
  attendantId: string;
  clientJid: string;
  nature: string;
  outcome: string;
  resolved: boolean;
  contracted: boolean;
  notes?: string;
  createdAt: number;
}

export interface AttendanceCustomerMessages {
  queueEntry: string;
  queueNext: string;
  queueUpdate: string;
  queueStatus: string;
}

interface AttendanceSettingsFile {
  macros: AttendanceMacro[];
  slaTargets: {
    firstResponseSeconds: number;
    queueWaitSeconds: number;
  };
  defaultMaxConcurrentChats?: number;
  sessionReviews?: SessionReview[];
  customerMessages?: Partial<AttendanceCustomerMessages>;
}

interface ClosedSessionMetric {
  sessionId: string;
  attendantId: string;
  endedAt: number;
  totalMessages: number;
  firstResponseSeconds?: number;
  queueWaitSeconds?: number;
}

const PRIORITY_SCORE: Record<QueuePriority, number> = {
  urgent: 4,
  high: 3,
  normal: 2,
  low: 1
};

export class AttendanceManager {
  private attendants: Map<string, Attendant> = new Map();
  private sessions: Map<string, AttendanceSession> = new Map();
  private clientToSession: Map<string, string> = new Map();
  private clientToQueuePosition: Map<string, number> = new Map();
  private clientLastNotificationPosition: Map<string, number> = new Map();
  private waitingQueue: QueuedClient[] = [];
  private sock: WASocket | null = null;
  private attendantsFile: string;
  private settingsFile: string;
  private queueCounters = { entered: 0, served: 0, abandoned: 0 };
  private closedSessionMetrics: ClosedSessionMetric[] = [];
  private macros: AttendanceMacro[] = [];
  private sessionReviews: SessionReview[] = [];
  private readonly presenceTimeoutMs = 45000;
  private slaTargets = {
    firstResponseSeconds: 120,
    queueWaitSeconds: 300
  };
  private defaultMaxConcurrentChats = 1;
  private customerMessages: AttendanceCustomerMessages = {
    queueEntry:
      'Todos os atendentes estao ocupados no momento.\n'
      + 'Voce foi adicionado a fila de atendimento.\n'
      + 'Posicao: {position}\n'
      + 'Tempo estimado: {estimatedMinutes} minuto(s).\n'
      + '{positionMessage}\n\n'
      + 'Digite "menu" a qualquer momento para sair da fila.',
    queueNext: 'Voce e o proximo da fila. Um atendente vai assumir seu caso em alguns instantes.',
    queueUpdate: 'Atualizacao da fila: voce esta em {position}o e faltam {remaining} pessoa(s). Tempo estimado: {estimatedMinutes} minuto(s).',
    queueStatus:
      'Voce continua na fila de atendimento.\n'
      + 'Posicao atual: {position}.\n'
      + 'Tempo estimado atual: {estimatedMinutes} minuto(s).\n'
      + 'Tempo medio observado: {avgMinutes} minuto(s).\n\n'
      + 'Para sair da fila e voltar ao menu principal, digite: menu'
  };

  public menuManager: MenuManager;

  constructor() {
    this.attendantsFile = path.join(__dirname, '../config/attendants.json');
    this.settingsFile = path.join(__dirname, '../config/attendance-settings.json');
    this.menuManager = new MenuManager();
    this.loadSettingsFromFile();
    this.loadAttendantsFromFile();
  }

  public setSocket(sock: WASocket) {
    this.sock = sock;
  }

  private loadAttendantsFromFile() {
    try {
      if (!fs.existsSync(this.attendantsFile)) return;
      const attendantsRaw = fs.readFileSync(this.attendantsFile, 'utf-8').replace(/^\uFEFF/, '');
      const attendants = JSON.parse(attendantsRaw);
      if (!Array.isArray(attendants)) return;

      attendants.forEach((raw: Partial<Attendant>) => {
        if (!raw.id || !raw.name || !raw.email || !raw.login || !raw.password) return;
        const normalized: Attendant = {
          id: raw.id,
          name: raw.name,
          email: raw.email,
          login: raw.login,
          password: raw.password,
          status: raw.status || 'online',
          lastSeenAt: Number((raw as any).lastSeenAt) > 0 ? Number((raw as any).lastSeenAt) : 0,
          // Sessões ativas não são restauradas no boot; evitar ocupação fantasma.
          activeChats: [],
          createdAt: raw.createdAt || Date.now(),
          skills: Array.isArray(raw.skills) ? raw.skills.map(s => String(s).toLowerCase()) : [],
          maxConcurrentChats: Number(raw.maxConcurrentChats) > 0
            ? Number(raw.maxConcurrentChats)
            : this.defaultMaxConcurrentChats
        };
        if (normalized.status === 'busy') {
          normalized.status = 'online';
        }
        this.attendants.set(normalized.id, normalized);
      });
    } catch (error) {
      console.error('Erro ao carregar atendentes:', error);
    }
  }

  private saveAttendantsToFile() {
    try {
      const configDir = path.dirname(this.attendantsFile);
      if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(this.attendantsFile, JSON.stringify(Array.from(this.attendants.values()), null, 2));
    } catch (error) {
      console.error('Erro ao salvar atendentes:', error);
    }
  }

  private loadSettingsFromFile() {
    try {
      if (!fs.existsSync(this.settingsFile)) {
        this.saveSettingsToFile();
        return;
      }

      const settingsRaw = fs.readFileSync(this.settingsFile, 'utf-8').replace(/^\uFEFF/, '');
      const data = JSON.parse(settingsRaw) as Partial<AttendanceSettingsFile>;
      const macros = Array.isArray(data.macros) ? data.macros : [];
      this.macros = macros
        .map(m => ({
          id: m.id,
          title: m.title,
          text: m.text,
          category: m.category || 'geral',
          approved: m.approved ?? true,
          version: Number(m.version) > 0 ? Number(m.version) : 1,
          updatedAt: Number(m.updatedAt) > 0 ? Number(m.updatedAt) : Date.now(),
          updatedBy: m.updatedBy || 'system'
        }))
        .filter(m => m.id && m.title && m.text);

      this.slaTargets = {
        firstResponseSeconds: data.slaTargets?.firstResponseSeconds || 120,
        queueWaitSeconds: data.slaTargets?.queueWaitSeconds || 300
      };
      this.defaultMaxConcurrentChats = Math.max(1, Number(data.defaultMaxConcurrentChats) || 1);
      this.sessionReviews = Array.isArray(data.sessionReviews) ? data.sessionReviews : [];
      this.customerMessages = {
        ...this.customerMessages,
        ...(data.customerMessages || {})
      };
    } catch (error) {
      console.error('Erro ao carregar configurações de atendimento:', error);
    }
  }

  private saveSettingsToFile() {
    try {
      const configDir = path.dirname(this.settingsFile);
      if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
      const payload: AttendanceSettingsFile = {
        macros: this.macros,
        slaTargets: this.slaTargets,
        defaultMaxConcurrentChats: this.defaultMaxConcurrentChats,
        sessionReviews: this.sessionReviews,
        customerMessages: this.customerMessages
      };
      fs.writeFileSync(this.settingsFile, JSON.stringify(payload, null, 2));
    } catch (error) {
      console.error('Erro ao salvar configurações de atendimento:', error);
    }
  }

  private renderTemplate(template: string, variables: Record<string, string | number>): string {
    return String(template || '').replace(/\{(\w+)\}/g, (_match, key: string) => {
      const value = variables[key];
      return value === undefined || value === null ? '' : String(value);
    });
  }

  public getCustomerMessages(): AttendanceCustomerMessages {
    return { ...this.customerMessages };
  }

  public updateCustomerMessages(messages: Partial<AttendanceCustomerMessages>): AttendanceCustomerMessages {
    const next: AttendanceCustomerMessages = { ...this.customerMessages };
    const keys: Array<keyof AttendanceCustomerMessages> = ['queueEntry', 'queueNext', 'queueUpdate', 'queueStatus'];
    for (const key of keys) {
      const raw = messages[key];
      if (typeof raw !== 'string') continue;
      const normalized = raw.replace(/\r\n/g, '\n').trim();
      if (!normalized) continue;
      next[key] = normalized;
    }
    this.customerMessages = next;
    this.saveSettingsToFile();
    return this.getCustomerMessages();
  }

  public getQueueUpdateMessage(position: number, remaining: number, estimatedWaitMinutes: number): string {
    if (position === 1) {
      return this.renderTemplate(this.customerMessages.queueNext, {
        position,
        remaining,
        estimatedMinutes: estimatedWaitMinutes
      });
    }

    return this.renderTemplate(this.customerMessages.queueUpdate, {
      position,
      remaining,
      estimatedMinutes: estimatedWaitMinutes
    });
  }

  public getQueueEntryMessage(position: number, remaining: number, estimatedWaitMinutes: number): string {
    const positionMessage = this.getQueueUpdateMessage(position, remaining, estimatedWaitMinutes);
    return this.renderTemplate(this.customerMessages.queueEntry, {
      position,
      remaining,
      estimatedMinutes: estimatedWaitMinutes,
      positionMessage
    });
  }

  public getQueueStatusMessage(position: number, estimatedWaitMinutes: number, avgQueueMinutes: number): string {
    return this.renderTemplate(this.customerMessages.queueStatus, {
      position,
      estimatedMinutes: estimatedWaitMinutes,
      avgMinutes: avgQueueMinutes
    });
  }

  private reconcileAttendantLoads() {
    const activeByAttendant = new Map<string, Set<string>>();
    for (const session of this.sessions.values()) {
      if (!session.isActive) continue;
      if (!activeByAttendant.has(session.attendantId)) {
        activeByAttendant.set(session.attendantId, new Set());
      }
      activeByAttendant.get(session.attendantId)!.add(session.clientJid);
    }

    let changed = false;
    for (const attendant of this.attendants.values()) {
      const realActive = Array.from(activeByAttendant.get(attendant.id) || []);
      const previousActive = attendant.activeChats || [];
      if (realActive.length !== previousActive.length || realActive.some((jid, i) => previousActive[i] !== jid)) {
        attendant.activeChats = realActive;
        changed = true;
      }

      if (attendant.status !== 'offline') {
        const nextStatus = attendant.activeChats.length > 0 ? 'busy' : 'online';
        if (attendant.status !== nextStatus) {
          attendant.status = nextStatus;
          changed = true;
        }
      }
    }

    if (changed) {
      this.saveAttendantsToFile();
    }
  }

  private reconcilePresence() {
    const now = Date.now();
    let changed = false;

    for (const attendant of this.attendants.values()) {
      if (attendant.status === 'offline') continue;
      if (!attendant.lastSeenAt || (now - attendant.lastSeenAt) > this.presenceTimeoutMs) {
        attendant.status = 'offline';
        changed = true;
      }
    }

    if (changed) {
      this.saveAttendantsToFile();
    }
  }

  public getAvailableAttendants(requestedSkill?: string): Attendant[] {
    this.reconcilePresence();
    this.reconcileAttendantLoads();
    const skill = requestedSkill?.toLowerCase();
    return Array.from(this.attendants.values())
      .filter(att => att.status !== 'offline')
      .filter(att => att.activeChats.length < (att.maxConcurrentChats || this.defaultMaxConcurrentChats))
      .filter(att => !skill || att.skills.includes(skill))
      .sort((a, b) => a.activeChats.length - b.activeChats.length);
  }

  private scoreAttendant(att: Attendant, requestedSkill?: string, priority: QueuePriority = 'normal'): number {
    const loadFactor = (att.activeChats.length / Math.max(att.maxConcurrentChats || this.defaultMaxConcurrentChats, 1)) * 100;
    const skillBonus = requestedSkill && att.skills.includes(requestedSkill.toLowerCase()) ? 35 : 0;
    const priorityBonus = PRIORITY_SCORE[priority] * 3;
    return 100 - loadFactor + skillBonus + priorityBonus;
  }

  public getLeastBusyAttendant(requestedSkill?: string, priority: QueuePriority = 'normal'): Attendant | null {
    let candidates = this.getAvailableAttendants(requestedSkill);
    if (candidates.length === 0 && requestedSkill) {
      candidates = this.getAvailableAttendants();
    }
    if (candidates.length === 0) return null;

    return candidates.sort((a, b) =>
      this.scoreAttendant(b, requestedSkill, priority) - this.scoreAttendant(a, requestedSkill, priority)
    )[0];
  }

  public getAllAttendants(): Attendant[] {
    this.reconcilePresence();
    return Array.from(this.attendants.values());
  }

  public createSession(
    clientJid: string,
    attendantId: string,
    options?: {
      priority?: QueuePriority;
      requestedSkill?: string;
      reason?: string;
      summary?: string;
      tags?: string[];
      queuedAt?: number;
      assignedAt?: number;
    }
  ): AttendanceSession {
    const now = Date.now();
    const assignedAt = options?.assignedAt || now;
    const queueWaitSeconds = options?.queuedAt ? Math.max(0, Math.floor((assignedAt - options.queuedAt) / 1000)) : undefined;
    const sessionId = `session-${now}-${Math.random().toString(36).slice(2, 11)}`;

    const session: AttendanceSession = {
      sessionId,
      clientJid,
      attendantId,
      startTime: now,
      isActive: true,
      botEnabled: false,
      messages: [],
      handoff: {
        priority: options?.priority || 'normal',
        requestedSkill: options?.requestedSkill,
        reason: options?.reason,
        summary: options?.summary,
        tags: options?.tags || [],
        queuedAt: options?.queuedAt,
        assignedAt,
        queueWaitSeconds
      },
      metrics: {
        queueWaitSeconds,
        totalMessages: 0
      }
    };

    this.sessions.set(sessionId, session);
    this.clientToSession.set(clientJid, sessionId);

    const attendant = this.attendants.get(attendantId);
    if (attendant) {
      if (!attendant.activeChats.includes(clientJid)) {
        attendant.activeChats.push(clientJid);
      }
      attendant.status = attendant.activeChats.length > 0 ? 'busy' : 'online';
      attendant.lastSeenAt = Date.now();
      this.saveAttendantsToFile();
    }

    return session;
  }

  public createAutoSession(
    clientJid: string,
    clientName: string,
    options?: {
      priority?: QueuePriority;
      requestedSkill?: string;
      reason?: string;
      summary?: string;
      tags?: string[];
    }
  ): { inQueue: true; queuedClient: QueuedClient } | { inQueue: false; session: AttendanceSession; attendant: Attendant } {
    this.reconcileAttendantLoads();
    const attendant = this.getLeastBusyAttendant(options?.requestedSkill, options?.priority || 'normal');
    if (!attendant) {
      const queuedClient = this.addToQueue(clientJid, clientName, options);
      return { inQueue: true, queuedClient };
    }

    const session = this.createSession(clientJid, attendant.id, options);
    return { inQueue: false, session, attendant };
  }

  public getActiveSession(clientJid: string): AttendanceSession | null {
    const sessionId = this.clientToSession.get(clientJid);
    if (!sessionId) return null;
    const session = this.sessions.get(sessionId);
    return session && session.isActive ? session : null;
  }

  public getSessionById(sessionId: string): AttendanceSession | null {
    return this.sessions.get(sessionId) || null;
  }

  public transferSession(sessionId: string, targetAttendantId: string): { success: boolean; error?: string; session?: AttendanceSession } {
    const session = this.sessions.get(sessionId);
    if (!session || !session.isActive) {
      return { success: false, error: 'Sessao nao encontrada' };
    }

    if (session.attendantId === targetAttendantId) {
      return { success: false, error: 'Sessao ja esta com este atendente' };
    }

    const fromAttendant = this.attendants.get(session.attendantId);
    const toAttendant = this.attendants.get(targetAttendantId);
    if (!toAttendant) {
      return { success: false, error: 'Atendente de destino nao encontrado' };
    }

    if (toAttendant.status === 'offline') {
      return { success: false, error: 'Atendente de destino esta offline' };
    }

    const capacity = Math.max(1, Number(toAttendant.maxConcurrentChats) || this.defaultMaxConcurrentChats);
    if (!toAttendant.activeChats.includes(session.clientJid) && toAttendant.activeChats.length >= capacity) {
      return { success: false, error: 'Atendente de destino sem capacidade no momento' };
    }

    if (fromAttendant) {
      fromAttendant.activeChats = fromAttendant.activeChats.filter(jid => jid !== session.clientJid);
      if (fromAttendant.status !== 'offline') {
        fromAttendant.status = fromAttendant.activeChats.length > 0 ? 'busy' : 'online';
      }
      fromAttendant.lastSeenAt = Date.now();
    }

    if (!toAttendant.activeChats.includes(session.clientJid)) {
      toAttendant.activeChats.push(session.clientJid);
    }
    toAttendant.status = toAttendant.activeChats.length > 0 ? 'busy' : 'online';
    toAttendant.lastSeenAt = Date.now();

    session.attendantId = toAttendant.id;
    session.messages.push({
      type: 'bot',
      text: `Sessao transferida para ${toAttendant.name}.`,
      timestamp: Date.now()
    });

    this.saveAttendantsToFile();
    return { success: true, session };
  }

  public getAttendantConversationIndex(attendantId: string): Array<{
    clientJid: string;
    sessionId: string;
    isActive: boolean;
    startTime: number;
    endTime?: number;
    lastMessageAt?: number;
    lastMessagePreview: string;
    totalMessages: number;
  }> {
    const entries = Array.from(this.sessions.values())
      .filter(s => s.attendantId === attendantId)
      .map(session => {
        const lastMessage = session.messages.length > 0 ? session.messages[session.messages.length - 1] : null;
        return {
          clientJid: session.clientJid,
          sessionId: session.sessionId,
          isActive: session.isActive,
          startTime: session.startTime,
          endTime: session.endTime,
          lastMessageAt: lastMessage?.timestamp,
          lastMessagePreview: lastMessage?.text?.slice(0, 80) || 'Sem mensagens',
          totalMessages: session.messages.length
        };
      })
      .sort((a, b) => (b.lastMessageAt || b.startTime) - (a.lastMessageAt || a.startTime));

    const uniqueByClient = new Map<string, typeof entries[number]>();
    for (const item of entries) {
      if (!uniqueByClient.has(item.clientJid)) {
        uniqueByClient.set(item.clientJid, item);
      }
    }
    return Array.from(uniqueByClient.values());
  }

  public getAttendantConversationHistory(attendantId: string, clientJid: string): AttendanceMessage[] {
    const messages = Array.from(this.sessions.values())
      .filter(s => s.attendantId === attendantId && s.clientJid === clientJid)
      .flatMap(s => s.messages.map(m => ({ ...m })));

    return messages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  }

  public addMessageToSession(sessionId: string, type: 'client' | 'attendant' | 'bot', text: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    const now = Date.now();
    session.messages.push({ type, text, timestamp: now });
    session.metrics.totalMessages += 1;

    if (type === 'client' && !session.metrics.firstClientMessageAt) {
      session.metrics.firstClientMessageAt = now;
    }

    if (type === 'attendant' && !session.metrics.firstAttendantReplyAt) {
      session.metrics.firstAttendantReplyAt = now;
      if (session.metrics.firstClientMessageAt) {
        session.metrics.firstResponseSeconds = Math.max(
          0,
          Math.floor((now - session.metrics.firstClientMessageAt) / 1000)
        );
      }
    }

    return true;
  }

  public toggleBotStatus(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.botEnabled = !session.botEnabled;
    return true;
  }

  public isBotEnabled(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return session ? session.botEnabled : false;
  }

  public async endSession(sessionId: string, silent: boolean = false, finalMessage?: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    session.isActive = false;
    session.endTime = Date.now();
    this.clientToSession.delete(session.clientJid);

    const attendant = this.attendants.get(session.attendantId);
    if (attendant) {
      attendant.activeChats = attendant.activeChats.filter(jid => jid !== session.clientJid);
      attendant.status = attendant.activeChats.length > 0 ? 'busy' : 'online';
      attendant.lastSeenAt = Date.now();
      this.saveAttendantsToFile();
    }

    this.closedSessionMetrics.push({
      sessionId: session.sessionId,
      attendantId: session.attendantId,
      endedAt: session.endTime,
      totalMessages: session.metrics.totalMessages,
      firstResponseSeconds: session.metrics.firstResponseSeconds,
      queueWaitSeconds: session.metrics.queueWaitSeconds
    });
    if (this.closedSessionMetrics.length > 1000) {
      this.closedSessionMetrics = this.closedSessionMetrics.slice(-1000);
    }

    if (!silent && this.sock) {
      await this.sock.sendMessage(session.clientJid, {
        text: (finalMessage && finalMessage.trim())
          ? finalMessage
          : 'Atendimento finalizado. O bot foi reativado para responder automaticamente.'
      });
    }

    if (this.waitingQueue.length > 0) {
      setTimeout(() => {
        this.tryProcessQueue();
      }, 500);
    }

    return true;
  }

  public getSessionHistory(sessionId: string): AttendanceSession['messages'] {
    const session = this.sessions.get(sessionId);
    return session ? session.messages : [];
  }

  public getActiveSessions(): AttendanceSession[] {
    return Array.from(this.sessions.values()).filter(s => s.isActive);
  }

  public getAttendantSessions(attendantId: string): AttendanceSession[] {
    return Array.from(this.sessions.values()).filter(s => s.attendantId === attendantId && s.isActive);
  }

  public updateAttendantStatus(attendantId: string, status: 'online' | 'offline' | 'busy'): boolean {
    const attendant = this.attendants.get(attendantId);
    if (!attendant) return false;

    const previous = attendant.status;
    attendant.status = status;
    attendant.lastSeenAt = Date.now();
    this.saveAttendantsToFile();

    if ((previous === 'busy' || previous === 'offline') && status === 'online') {
      this.tryProcessQueue();
    }

    return true;
  }

  private sortQueue() {
    this.waitingQueue.sort((a, b) => {
      const p = PRIORITY_SCORE[b.priority] - PRIORITY_SCORE[a.priority];
      if (p !== 0) return p;
      return a.queuedAt - b.queuedAt;
    });
    this.waitingQueue.forEach((client, idx) => {
      this.clientToQueuePosition.set(client.clientJid, idx);
    });
  }

  private async tryProcessQueue(): Promise<void> {
    this.sortQueue();

    while (this.waitingQueue.length > 0) {
      const nextClient = this.getNextFromQueue();
      if (!nextClient) break;

      const attendant = this.getLeastBusyAttendant(nextClient.requestedSkill, nextClient.priority);
      if (!attendant) break;

      this.removeFromQueue(nextClient.clientJid, 'assigned');
      this.queueCounters.served += 1;

      this.createSession(nextClient.clientJid, attendant.id, {
        priority: nextClient.priority,
        requestedSkill: nextClient.requestedSkill,
        reason: nextClient.reason,
        summary: nextClient.summary,
        tags: nextClient.tags,
        queuedAt: nextClient.queuedAt,
        assignedAt: Date.now()
      });

      if (this.sock) {
        try {
          await this.sock.sendMessage(nextClient.clientJid, {
            text: `Otima noticia! Voce esta sendo atendido por ${attendant.name}.`
          });
        } catch (error) {
          console.error(`Erro ao notificar cliente ${nextClient.clientJid}:`, error);
        }
      }
    }

    await this.notifyQueueUpdates();
  }

  public getAttendantById(attendantId: string): Attendant | null {
    return this.attendants.get(attendantId) || null;
  }

  public addAttendant(
    name: string,
    email: string,
    login: string,
    password: string,
    maxConcurrentChats?: number
  ): Attendant {
    const id = `att-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    const attendant: Attendant = {
      id,
      name,
      email,
      login,
      password,
      status: 'online',
      lastSeenAt: Date.now(),
      activeChats: [],
      createdAt: Date.now(),
      skills: [],
      maxConcurrentChats: Number(maxConcurrentChats) > 0
        ? Number(maxConcurrentChats)
        : this.defaultMaxConcurrentChats
    };

    this.attendants.set(id, attendant);
    this.saveAttendantsToFile();
    return attendant;
  }

  public authenticateAttendant(login: string, password: string): Attendant | null {
    for (const attendant of this.attendants.values()) {
      if (attendant.login === login && attendant.password === password) return attendant;
    }
    return null;
  }

  public loginExists(login: string): boolean {
    for (const attendant of this.attendants.values()) {
      if (attendant.login === login) return true;
    }
    return false;
  }

  public updateAttendant(
    attendantId: string,
    name: string,
    email: string,
    login: string,
    password?: string,
    maxConcurrentChats?: number
  ): Attendant | null {
    const attendant = this.attendants.get(attendantId);
    if (!attendant) return null;

    attendant.name = name;
    attendant.email = email;
    attendant.login = login;
    if (password && password.trim()) attendant.password = password;
    if (Number(maxConcurrentChats) > 0) attendant.maxConcurrentChats = Number(maxConcurrentChats);
    this.saveAttendantsToFile();
    return attendant;
  }

  public updateAttendantProfile(
    attendantId: string,
    profile: Partial<Pick<Attendant, 'skills' | 'maxConcurrentChats' | 'status'>>
  ): Attendant | null {
    const attendant = this.attendants.get(attendantId);
    if (!attendant) return null;

    if (profile.skills) attendant.skills = profile.skills.map(s => s.toLowerCase());
    if (profile.maxConcurrentChats && profile.maxConcurrentChats > 0) attendant.maxConcurrentChats = profile.maxConcurrentChats;
    if (profile.status) {
      attendant.status = profile.status;
      attendant.lastSeenAt = Date.now();
    }
    this.saveAttendantsToFile();
    return attendant;
  }

  public removeAttendant(attendantId: string): boolean {
    const attendant = this.attendants.get(attendantId);
    if (!attendant) return false;

    if (attendant.activeChats.length > 0) {
      const otherAttendants = this.getAvailableAttendants().filter(a => a.id !== attendantId);
      if (otherAttendants.length > 0) {
        const target = otherAttendants[0];
        for (const clientJid of attendant.activeChats) {
          const session = this.getActiveSession(clientJid);
          if (session) {
            session.attendantId = target.id;
            target.activeChats.push(clientJid);
          }
        }
      }
    }

    this.attendants.delete(attendantId);
    this.saveAttendantsToFile();
    return true;
  }

  public addToQueue(
    clientJid: string,
    clientName: string,
    options?: {
      priority?: QueuePriority;
      requestedSkill?: string;
      reason?: string;
      summary?: string;
      tags?: string[];
    }
  ): QueuedClient {
    const existing = this.waitingQueue.find(q => q.clientJid === clientJid);
    if (existing) return existing;

    const queuedClient: QueuedClient = {
      clientJid,
      clientName,
      queuedAt: Date.now(),
      estimatedPosition: this.waitingQueue.length + 1,
      priority: options?.priority || 'normal',
      requestedSkill: options?.requestedSkill?.toLowerCase(),
      reason: options?.reason,
      summary: options?.summary,
      tags: options?.tags || []
    };

    this.waitingQueue.push(queuedClient);
    this.queueCounters.entered += 1;
    this.sortQueue();
    return queuedClient;
  }

  public getQueuePosition(clientJid: string): number {
    return this.clientToQueuePosition.get(clientJid) ?? -1;
  }

  public getQueueSize(): number {
    return this.waitingQueue.length;
  }

  public getWaitingQueue(): QueuedClient[] {
    this.sortQueue();
    return [...this.waitingQueue].map((client, index) => ({ ...client, estimatedPosition: index + 1 }));
  }

  public getQueuePositionDetailed(clientJid: string): {
    position: number;
    remaining: number;
    isNextInLine: boolean;
    estimatedWaitMinutes: number;
    message: string;
  } | null {
    this.sortQueue();
    const index = this.waitingQueue.findIndex(q => q.clientJid === clientJid);
    if (index === -1) return null;

    const position = index + 1;
    const remaining = Math.max(0, position - 1);
    const isNextInLine = position === 1;
    const estimatedWaitMinutes = Math.max(1, position * 5);
    const message = this.getQueueUpdateMessage(position, remaining, estimatedWaitMinutes);

    return { position, remaining, isNextInLine, estimatedWaitMinutes, message };
  }

  public setQueuePriority(clientJid: string, priority: QueuePriority): boolean {
    const client = this.waitingQueue.find(q => q.clientJid === clientJid);
    if (!client) return false;
    client.priority = priority;
    this.sortQueue();
    return true;
  }

  public removeFromQueue(clientJid: string, reason: 'manual_remove' | 'assigned' | 'abandoned' = 'manual_remove'): boolean {
    const index = this.waitingQueue.findIndex(q => q.clientJid === clientJid);
    if (index === -1) return false;

    this.waitingQueue.splice(index, 1);
    this.clientToQueuePosition.delete(clientJid);
    this.clientLastNotificationPosition.delete(clientJid);
    this.sortQueue();

    if (reason !== 'assigned') {
      this.queueCounters.abandoned += 1;
    }
    return true;
  }

  public async notifyQueueUpdates(): Promise<void> {
    if (!this.sock || this.waitingQueue.length === 0) return;
    this.sortQueue();

    for (let i = 0; i < this.waitingQueue.length; i++) {
      const client = this.waitingQueue[i];
      const position = i + 1;
      const remaining = Math.max(0, position - 1);
      const lastNotification = this.clientLastNotificationPosition.get(client.clientJid) ?? -1;
      const shouldNotify = lastNotification === -1 || position < lastNotification || (position === 1 && lastNotification !== 1);
      if (!shouldNotify) continue;

      try {
        const estimatedWaitMinutes = Math.max(1, position * 5);
        const msg = this.getQueueUpdateMessage(position, remaining, estimatedWaitMinutes);
        await this.sock.sendMessage(client.clientJid, { text: msg });
        this.clientLastNotificationPosition.set(client.clientJid, position);
      } catch (error) {
        console.error(`Erro ao notificar cliente ${client.clientJid}:`, error);
      }
    }
  }

  public getNextFromQueue(): QueuedClient | null {
    this.sortQueue();
    return this.waitingQueue.length === 0 ? null : { ...this.waitingQueue[0], estimatedPosition: 1 };
  }

  public async processQueue(): Promise<QueuedClient | null> {
    const next = this.getNextFromQueue();
    if (!next) return null;

    const attendant = this.getLeastBusyAttendant(next.requestedSkill, next.priority);
    if (!attendant) return null;

    this.removeFromQueue(next.clientJid, 'assigned');
    this.queueCounters.served += 1;
    this.createSession(next.clientJid, attendant.id, {
      priority: next.priority,
      requestedSkill: next.requestedSkill,
      reason: next.reason,
      summary: next.summary,
      tags: next.tags,
      queuedAt: next.queuedAt
    });
    return next;
  }

  public pullNextFromQueueByAttendant(attendantId: string): { success: boolean; error?: string; session?: AttendanceSession; client?: QueuedClient } {
    const attendant = this.attendants.get(attendantId);
    if (!attendant) return { success: false, error: 'Atendente nao encontrado' };
    if (attendant.status === 'offline') return { success: false, error: 'Atendente esta offline' };

    const capacity = Math.max(1, Number(attendant.maxConcurrentChats) || this.defaultMaxConcurrentChats);
    if (attendant.activeChats.length >= capacity) {
      return { success: false, error: 'Atendente sem capacidade no momento' };
    }

    const next = this.getNextFromQueue();
    if (!next) return { success: false, error: 'Fila vazia' };

    this.removeFromQueue(next.clientJid, 'assigned');
    this.queueCounters.served += 1;
    const session = this.createSession(next.clientJid, attendant.id, {
      priority: next.priority,
      requestedSkill: next.requestedSkill,
      reason: next.reason,
      summary: next.summary,
      tags: next.tags,
      queuedAt: next.queuedAt
    });
    return { success: true, session, client: next };
  }

  public startQueuedClientByAttendant(attendantId: string, clientJid: string): { success: boolean; error?: string; session?: AttendanceSession; client?: QueuedClient } {
    const attendant = this.attendants.get(attendantId);
    if (!attendant) return { success: false, error: 'Atendente nao encontrado' };
    if (attendant.status === 'offline') return { success: false, error: 'Atendente esta offline' };

    this.sortQueue();
    const queued = this.waitingQueue.find(q => q.clientJid === clientJid);
    if (!queued) return { success: false, error: 'Cliente nao esta na fila' };

    this.removeFromQueue(queued.clientJid, 'assigned');
    this.queueCounters.served += 1;
    const session = this.createSession(queued.clientJid, attendant.id, {
      priority: queued.priority,
      requestedSkill: queued.requestedSkill,
      reason: queued.reason,
      summary: queued.summary,
      tags: queued.tags,
      queuedAt: queued.queuedAt
    });

    return { success: true, session, client: queued };
  }

  public isInQueue(clientJid: string): boolean {
    return this.waitingQueue.some(q => q.clientJid === clientJid);
  }

  public getSessionHandoffContext(sessionId: string, historyLimit: number = 20) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const attendant = this.attendants.get(session.attendantId);
    return {
      sessionId: session.sessionId,
      clientJid: session.clientJid,
      attendant: attendant ? { id: attendant.id, name: attendant.name, skills: attendant.skills } : null,
      handoff: session.handoff,
      metrics: session.metrics,
      recentMessages: session.messages.slice(-Math.max(historyLimit, 1))
    };
  }

  public saveSessionReview(params: {
    sessionId: string;
    nature: string;
    outcome: string;
    resolved: boolean;
    contracted: boolean;
    notes?: string;
  }): SessionReview | null {
    const session = this.sessions.get(params.sessionId);
    if (!session) return null;

    const review: SessionReview = {
      sessionId: session.sessionId,
      attendantId: session.attendantId,
      clientJid: session.clientJid,
      nature: (params.nature || '').trim() || 'outro',
      outcome: (params.outcome || '').trim() || 'nao_resolvido',
      resolved: Boolean(params.resolved),
      contracted: Boolean(params.contracted),
      notes: (params.notes || '').trim() || undefined,
      createdAt: Date.now()
    };

    this.sessionReviews = this.sessionReviews.filter(r => r.sessionId !== session.sessionId);
    this.sessionReviews.push(review);
    this.saveSettingsToFile();
    return review;
  }

  public getSessionReviews(filters?: { nature?: string; outcome?: string; attendantId?: string }) {
    let items = [...this.sessionReviews];
    if (filters?.nature) items = items.filter(r => r.nature === filters.nature);
    if (filters?.outcome) items = items.filter(r => r.outcome === filters.outcome);
    if (filters?.attendantId) items = items.filter(r => r.attendantId === filters.attendantId);
    return items.sort((a, b) => b.createdAt - a.createdAt);
  }

  public getConversationAnalytics(filters?: { nature?: string; outcome?: string; attendantId?: string }) {
    const reviews = this.getSessionReviews(filters);
    const result = reviews.map(review => {
      const session = this.sessions.get(review.sessionId);
      return {
        review,
        session: session ? {
          sessionId: session.sessionId,
          clientJid: session.clientJid,
          attendantId: session.attendantId,
          startTime: session.startTime,
          endTime: session.endTime,
          totalMessages: session.messages.length
        } : {
          sessionId: review.sessionId,
          clientJid: review.clientJid,
          attendantId: review.attendantId,
          startTime: undefined,
          endTime: undefined,
          totalMessages: 0
        }
      };
    });

    return {
      total: result.length,
      resolved: result.filter(r => r.review.resolved).length,
      contracted: result.filter(r => r.review.contracted).length,
      items: result
    };
  }

  public getSlaSnapshot() {
    const activeSessions = this.getActiveSessions();
    const finished = this.closedSessionMetrics;
    const frValues = finished.map(s => s.firstResponseSeconds).filter((v): v is number => typeof v === 'number');
    const queueValues = finished.map(s => s.queueWaitSeconds).filter((v): v is number => typeof v === 'number');

    const avg = (arr: number[]) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0);
    const totalQueueEntries = this.queueCounters.entered || 0;
    const abandonmentRate = totalQueueEntries === 0 ? 0 : Number(((this.queueCounters.abandoned / totalQueueEntries) * 100).toFixed(2));

    return {
      targets: this.slaTargets,
      queue: {
        waitingNow: this.waitingQueue.length,
        entered: this.queueCounters.entered,
        served: this.queueCounters.served,
        abandoned: this.queueCounters.abandoned,
        abandonmentRate
      },
      response: {
        avgFirstResponseSeconds: avg(frValues),
        avgQueueWaitSeconds: avg(queueValues),
        breaches: {
          firstResponse: frValues.filter(v => v > this.slaTargets.firstResponseSeconds).length,
          queueWait: queueValues.filter(v => v > this.slaTargets.queueWaitSeconds).length
        }
      },
      sessions: {
        active: activeSessions.length,
        closedSampleSize: finished.length
      }
    };
  }

  public getMacros(): AttendanceMacro[] {
    return [...this.macros].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  public upsertMacro(
    macro: Pick<AttendanceMacro, 'id' | 'title' | 'text'> & Partial<Pick<AttendanceMacro, 'category' | 'approved' | 'updatedBy'>>
  ): AttendanceMacro {
    const existing = this.macros.find(m => m.id === macro.id);
    const now = Date.now();
    const next: AttendanceMacro = {
      id: macro.id,
      title: macro.title,
      text: macro.text,
      category: macro.category || existing?.category || 'geral',
      approved: macro.approved ?? existing?.approved ?? true,
      version: existing ? existing.version + 1 : 1,
      updatedAt: now,
      updatedBy: macro.updatedBy || 'admin'
    };

    this.macros = this.macros.filter(m => m.id !== macro.id);
    this.macros.push(next);
    this.saveSettingsToFile();
    return next;
  }

  public deleteMacro(macroId: string): boolean {
    const before = this.macros.length;
    this.macros = this.macros.filter(m => m.id !== macroId);
    if (this.macros.length !== before) {
      this.saveSettingsToFile();
      return true;
    }
    return false;
  }

  public setSlaTargets(firstResponseSeconds: number, queueWaitSeconds: number) {
    this.slaTargets = {
      firstResponseSeconds: Math.max(30, firstResponseSeconds),
      queueWaitSeconds: Math.max(60, queueWaitSeconds)
    };
    this.saveSettingsToFile();
    return this.slaTargets;
  }

  public getDefaultMaxConcurrentChats(): number {
    return this.defaultMaxConcurrentChats;
  }

  public setDefaultMaxConcurrentChats(maxConcurrentChats: number, applyToAll: boolean = false): number {
    this.defaultMaxConcurrentChats = Math.max(1, Number(maxConcurrentChats) || 1);

    if (applyToAll) {
      for (const attendant of this.attendants.values()) {
        attendant.maxConcurrentChats = this.defaultMaxConcurrentChats;
      }
      this.saveAttendantsToFile();
    }

    this.saveSettingsToFile();
    return this.defaultMaxConcurrentChats;
  }
}

