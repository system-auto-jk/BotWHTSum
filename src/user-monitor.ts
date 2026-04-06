/**
 * Sistema de Monitoramento de Usuários Online
 * Rastreia usuários conectados, posição no menu e permite ações de suporte
 */

import type { WASocket } from 'baileys';
import { BlockedUsersManager } from './blocked-users-manager';

export interface OnlineUser {
  jid: string;
  name: string;
  currentMenu: string; // ID do menu atual
  currentStep: string; // Descrição do que está fazendo
  lastActivity: number; // timestamp
  messagesSent: number;
  messagesReceived: number;
  isBlocked: boolean;
  sessionDuration: number; // em ms
  isInAttendance: boolean; // se está em atendimento com humano
  attendantId?: string;
}

export interface UserAction {
  userId: string;
  action: 'block' | 'intervene' | 'reset' | 'contact' | 'kick';
  timestamp: number;
  performedBy: string; // ID do admin que realizou
  reason?: string;
  result?: string;
}

export class UserMonitor {
  private onlineUsers: Map<string, OnlineUser> = new Map();
  private actionHistory: UserAction[] = [];
  private sock: WASocket | null = null;
  private updateCallbacks: ((users: OnlineUser[]) => void)[] = [];
  private blockedUsersManager: BlockedUsersManager | null = null;

  constructor() {}

  /**
   * Injetar referência ao BlockedUsersManager
   */
  public setBlockedUsersManager(manager: BlockedUsersManager) {
    this.blockedUsersManager = manager;
  }

  public setSocket(sock: WASocket) {
    this.sock = sock;
  }

  /**
   * Registrar ou atualizar usuário como online
   */
  public registerUser(jid: string, name: string, currentMenu: string = 'main'): OnlineUser {
    const existingUser = this.onlineUsers.get(jid);
    
    const user: OnlineUser = {
      jid,
      name,
      currentMenu,
      currentStep: this.getMenuStepDescription(currentMenu),
      lastActivity: Date.now(),
      messagesSent: existingUser?.messagesSent ?? 0,
      messagesReceived: existingUser?.messagesReceived ?? 0,
      isBlocked: existingUser?.isBlocked ?? false,
      sessionDuration: existingUser ? Date.now() - (existingUser.lastActivity - existingUser.sessionDuration) : 0,
      isInAttendance: existingUser?.isInAttendance ?? false,
      attendantId: existingUser?.attendantId
    };

    this.onlineUsers.set(jid, user);
    this.notifySubscribers();
    return user;
  }

  /**
   * Atualizar posição do usuário no menu
   */
  public updateUserMenu(jid: string, menuId: string): boolean {
    const user = this.onlineUsers.get(jid);
    if (!user) return false;

    user.currentMenu = menuId;
    user.currentStep = this.getMenuStepDescription(menuId);
    user.lastActivity = Date.now();
    
    this.notifySubscribers();
    return true;
  }

  /**
   * Incrementar contador de mensagens recebidas
   */
  public addMessageReceived(jid: string): boolean {
    const user = this.onlineUsers.get(jid);
    if (!user) return false;

    user.messagesReceived++;
    user.lastActivity = Date.now();
    user.sessionDuration = Date.now() - (user.lastActivity - user.sessionDuration);
    
    return true;
  }

  /**
   * Incrementar contador de mensagens enviadas
   */
  public addMessageSent(jid: string): boolean {
    const user = this.onlineUsers.get(jid);
    if (!user) return false;

    user.messagesSent++;
    user.lastActivity = Date.now();
    
    return true;
  }

  /**
   * Marcar usuário como em atendimento
   */
  public setUserInAttendance(jid: string, attendantId: string): boolean {
    const user = this.onlineUsers.get(jid);
    if (!user) return false;

    user.isInAttendance = true;
    user.attendantId = attendantId;
    
    this.notifySubscribers();
    return true;
  }

  /**
   * Desmarcar usuário de atendimento
   */
  public removeUserFromAttendance(jid: string): boolean {
    const user = this.onlineUsers.get(jid);
    if (!user) return false;

    user.isInAttendance = false;
    user.attendantId = undefined;
    
    this.notifySubscribers();
    return true;
  }

  /**
   * Remover usuário da lista de online
   */
  public removeUser(jid: string): boolean {
    const removed = this.onlineUsers.delete(jid);
    if (removed) {
      this.notifySubscribers();
    }
    return removed;
  }

  /**
   * Obter usuário
   */
  public getUser(jid: string): OnlineUser | null {
    return this.onlineUsers.get(jid) || null;
  }

  /**
   * Obter todos os usuários online
   */
  public getAllOnlineUsers(): OnlineUser[] {
    return Array.from(this.onlineUsers.values());
  }

  /**
   * Obter usuários por menu
   */
  public getUsersByMenu(menuId: string): OnlineUser[] {
    return Array.from(this.onlineUsers.values()).filter(u => u.currentMenu === menuId);
  }

  /**
   * Bloquear usuário
   */
  public async blockUser(jid: string, adminId: string, reason?: string): Promise<UserAction> {
    const user = this.onlineUsers.get(jid);
    
    const action: UserAction = {
      userId: jid,
      action: 'block',
      timestamp: Date.now(),
      performedBy: adminId,
      reason,
      result: 'success'
    };

    if (user) {
      user.isBlocked = true;
      
      // CRÍTICO: Também persistir em BlockedUsersManager
      if (this.blockedUsersManager) {
        const success = this.blockedUsersManager.blockUser(jid, user.name, reason);
        if (!success) {
          action.result = 'Bloqueado (já estava na lista)';
        }
      }
      
      // Notificar usuário
      if (this.sock) {
        try {
          await this.sock.sendMessage(jid, {
            text: '❌ Sua conta foi bloqueada. Entre em contato com o suporte se acredita que é um erro.'
          });
        } catch (error) {
          action.result = `Bloqueado (notificação falhou)`;
        }
      }
    }

    this.actionHistory.push(action);
    this.notifySubscribers();
    return action;
  }

  /**
   * Desbloquear usuário
   */
  public async unblockUser(jid: string, adminId: string): Promise<UserAction> {
    const user = this.onlineUsers.get(jid);
    
    const action: UserAction = {
      userId: jid,
      action: 'block',
      timestamp: Date.now(),
      performedBy: adminId,
      reason: 'Desbloqueado',
      result: 'success'
    };

    if (user) {
      user.isBlocked = false;
      
      // CRÍTICO: Também remover de BlockedUsersManager
      if (this.blockedUsersManager) {
        const success = this.blockedUsersManager.unblockUser(jid);
        if (!success) {
          action.result = 'Desbloqueado (não estava na lista)';
        }
      }
      
      // Notificar usuário
      if (this.sock) {
        try {
          await this.sock.sendMessage(jid, {
            text: '✅ Sua conta foi desbloqueada. Bem-vindo de volta!'
          });
        } catch (error) {
          action.result = 'Desbloqueado (notificação falhou)';
        }
      }
    }

    this.actionHistory.push(action);
    this.notifySubscribers();
    return action;
  }

  /**
   * Intervir no atendimento de um usuário
   * (Um admin pode assumir a conversa)
   */
  public async interveneUser(jid: string, adminId: string, adminName: string): Promise<UserAction> {
    const action: UserAction = {
      userId: jid,
      action: 'intervene',
      timestamp: Date.now(),
      performedBy: adminId,
      reason: `Intervenção de ${adminName}`,
      result: 'success'
    };

    if (this.sock) {
      try {
        await this.sock.sendMessage(jid, {
          text: `👥 Um administrador (${adminName}) está agora participando dessa conversa para melhor ajudá-lo.`
        });
      } catch (error) {
        action.result = 'Intervenção iniciada (notificação falhou)';
      }
    }

    this.actionHistory.push(action);
    return action;
  }

  /**
   * Resetar atendimento do usuário (voltar ao menu principal)
   */
  public async resetUserSession(jid: string, adminId: string): Promise<UserAction> {
    const user = this.onlineUsers.get(jid);
    
    const action: UserAction = {
      userId: jid,
      action: 'reset',
      timestamp: Date.now(),
      performedBy: adminId,
      reason: 'Reset de sessão por administrador',
      result: 'success'
    };

    if (user) {
      user.currentMenu = 'main';
      user.currentStep = 'Menu Principal';
      user.isInAttendance = false;
      user.attendantId = undefined;
      
      // Notificar usuário
      if (this.sock) {
        try {
          await this.sock.sendMessage(jid, {
            text: '🔄 Sua sessão foi resetada. Retornando ao menu principal...'
          });
        } catch (error) {
          action.result = 'Reset realizado (notificação falhou)';
        }
      }
    }

    this.actionHistory.push(action);
    this.notifySubscribers();
    return action;
  }

  /**
   * Entrar em contato direto com usuário
   */
  public async contactUser(jid: string, adminId: string, adminName: string, message: string): Promise<UserAction> {
    const action: UserAction = {
      userId: jid,
      action: 'contact',
      timestamp: Date.now(),
      performedBy: adminId,
      reason: `Contato direto de ${adminName}`,
      result: 'success'
    };

    if (this.sock) {
      try {
        const fullMessage = `📞 Contato direto de ${adminName}:\n\n${message}`;
        await this.sock.sendMessage(jid, { text: fullMessage });
      } catch (error) {
        action.result = 'Falha ao enviar mensagem';
      }
    }

    this.actionHistory.push(action);
    return action;
  }

  /**
   * Remover usuário (kick)
   */
  public async kickUser(jid: string, adminId: string, reason?: string): Promise<UserAction> {
    const action: UserAction = {
      userId: jid,
      action: 'kick',
      timestamp: Date.now(),
      performedBy: adminId,
      reason: reason || 'Removido por administrador',
      result: 'success'
    };

    if (this.sock) {
      try {
        const reasonText = reason || 'violação de políticas';
        await this.sock.sendMessage(jid, {
          text: `❌ Você foi removido do sistema por ${reasonText}. Contato: suporte@empresa.com`
        });
      } catch (error) {
        action.result = 'Removido (notificação falhou)';
      }
    }

    this.removeUser(jid);
    this.actionHistory.push(action);
    return action;
  }

  /**
   * Obter histórico de ações
   */
  public getActionHistory(limit: number = 100): UserAction[] {
    return this.actionHistory.slice(-limit);
  }

  /**
   * Obter ações por usuário
   */
  public getUserActions(jid: string): UserAction[] {
    return this.actionHistory.filter(a => a.userId === jid);
  }

  /**
   * Obter ações por admin
   */
  public getAdminActions(adminId: string): UserAction[] {
    return this.actionHistory.filter(a => a.performedBy === adminId);
  }

  /**
   * Limpar usuários inativos (sem atividade há X minutos)
   */
  public clearInactiveUsers(minutesThreshold: number = 30): number {
    const now = Date.now();
    const thresholdMs = minutesThreshold * 60 * 1000;
    let removed = 0;

    const inactiveUsers = Array.from(this.onlineUsers.entries()).filter(([_, user]) => {
      return now - user.lastActivity > thresholdMs;
    });

    inactiveUsers.forEach(([jid, _]) => {
      this.onlineUsers.delete(jid);
      removed++;
    });

    if (removed > 0) {
      this.notifySubscribers();
    }

    return removed;
  }

  /**
   * Registrar callback para atualizações
   */
  public onUsersUpdate(callback: (users: OnlineUser[]) => void): void {
    this.updateCallbacks.push(callback);
  }

  /**
   * Notificar subscribers sobre atualizações
   */
  private notifySubscribers(): void {
    const users = this.getAllOnlineUsers();
    this.updateCallbacks.forEach(cb => cb(users));
  }

  /**
   * Obter descrição da etapa no menu
   */
  private getMenuStepDescription(menuId: string): string {
    const descriptions: { [key: string]: string } = {
      'main': 'Menu Principal',
      'services': 'Serviços',
      'pricing': 'Preços',
      'faq': 'Perguntas Frequentes',
      'contact': 'Contato',
      'registration': 'Formulário de Registro',
      'registration_phone': 'Confirmando telefone',
      'registration_niche': 'Selecionando nicho',
      'registration_address': 'Informando endereço',
      'registration_services': 'Selecionando serviços',
      'registration_confirmation': 'Confirmando dados',
      'attendance': 'Em atendimento com humano'
    };

    return descriptions[menuId] || menuId;
  }

  /**
   * Obter estatísticas
   */
  public getStatistics() {
    const users = Array.from(this.onlineUsers.values());
    const now = Date.now();

    return {
      totalOnline: users.length,
      inAttendance: users.filter(u => u.isInAttendance).length,
      blocked: users.filter(u => u.isBlocked).length,
      byMenu: this.groupUsersByMenu(),
      averageSessionDuration: users.length > 0 
        ? users.reduce((sum, u) => sum + (now - (u.lastActivity - u.sessionDuration)), 0) / users.length
        : 0,
      totalActions: this.actionHistory.length,
      recentActions: this.actionHistory.slice(-10)
    };
  }

  /**
   * Agrupar usuários por menu
   */
  private groupUsersByMenu(): { [key: string]: number } {
    const groups: { [key: string]: number } = {};
    
    Array.from(this.onlineUsers.values()).forEach(user => {
      groups[user.currentMenu] = (groups[user.currentMenu] || 0) + 1;
    });

    return groups;
  }
}
