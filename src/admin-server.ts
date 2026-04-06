import express, { Request, Response } from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import * as fs from 'fs';
import * as path from 'path';
import type { WASocket, proto } from 'baileys';
import { AttendanceManager } from './attendance-manager';
import { UserMonitor, OnlineUser } from './user-monitor';
import { BlockedUsersManager } from './blocked-users-manager';
import {
  RegistrationField,
  RegistrationHandler,
  RegistrationPlan,
  registrationHandlerInstance
} from './registration-handler';
import { botStatus } from './bot-status';
import { MessageTemplateManager } from './message-template-manager';

interface MenuItem {
  id: string;
  label: string;
  action?: 'submenu' | 'attendant' | 'message' | 'registration';
  submenuId?: string;
  registrationPlan?: string;
  attendantType?: string;
  message?: string;
}

interface Menu {
  id: string;
  title: string;
  message: string;
  items: MenuItem[];
}

class MenuManager {
  private menus: Map<string, Menu> = new Map();

  constructor() {
    this.loadMenusFromFile();
  }

  private loadMenusFromFile() {
    try {
      const menusFile = path.join(__dirname, '../config/menus.json');
      if (fs.existsSync(menusFile)) {
        const data = fs.readFileSync(menusFile, 'utf-8');
        const menus = JSON.parse(data);
        menus.forEach((menu: Menu) => {
          const normalized = this.normalizeMenu(menu);
          this.menus.set(normalized.id, normalized);
        });
      }
    } catch (error) {
      console.error('Erro ao carregar menus:', error);
    }
  }

  private saveMenusToFile() {
    try {
      const configDir = path.join(__dirname, '../config');
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }
      const menusFile = path.join(configDir, 'menus.json');
      fs.writeFileSync(menusFile, JSON.stringify(Array.from(this.menus.values()), null, 2));
    } catch (error) {
      console.error('Erro ao salvar menus:', error);
    }
  }

  getAllMenus(): Menu[] {
    return Array.from(this.menus.values());
  }

  getMenuSummaries(): Array<{ id: string; title: string; itemCount: number }> {
    return this.getAllMenus()
      .map(menu => ({
        id: menu.id,
        title: menu.title,
        itemCount: Array.isArray(menu.items) ? menu.items.length : 0
      }))
      .sort((a, b) => a.title.localeCompare(b.title));
  }

  getMenu(menuId: string): Menu | undefined {
    return this.menus.get(menuId);
  }

  getMenuReferences(menuId: string): Array<{ menuId: string; menuTitle: string; itemId: string; itemLabel: string }> {
    const refs: Array<{ menuId: string; menuTitle: string; itemId: string; itemLabel: string }> = [];
    for (const menu of this.menus.values()) {
      for (const item of menu.items || []) {
        if (item.submenuId === menuId) {
          refs.push({
            menuId: menu.id,
            menuTitle: menu.title,
            itemId: item.id,
            itemLabel: item.label
          });
        }
      }
    }
    return refs;
  }

  getEditorMetadata() {
    const menuOptions = this.getMenuSummaries();
    return {
      menus: menuOptions,
      references: Object.fromEntries(menuOptions.map(menu => [menu.id, this.getMenuReferences(menu.id)])),
      actionTypes: [
        { value: 'submenu', label: 'Abrir submenu', valueLabel: 'Destino do submenu' },
        { value: 'message', label: 'Enviar mensagem fixa', valueLabel: 'Mensagem ou chave de conteudo' },
        { value: 'registration', label: 'Iniciar cadastro', valueLabel: 'Plano do cadastro' },
        { value: 'attendant', label: 'Encaminhar para atendente', valueLabel: 'Tipo de atendimento' }
      ],
      registrationPlans: [
        { value: 'basic', label: 'Plano Basico' },
        { value: 'professional', label: 'Plano Profissional' }
      ],
      attendantTypes: [
        { value: 'commercial', label: 'Comercial' },
        { value: 'support', label: 'Suporte' },
        { value: 'financial', label: 'Financeiro' }
      ]
    };
  }

  private inferItemAction(item: Partial<MenuItem>): MenuItem['action'] {
    if (item.action) return item.action;
    if (item.submenuId) return 'submenu';
    if (item.registrationPlan) return 'registration';
    if (item.attendantType) return 'attendant';
    return 'message';
  }

  private normalizeItem(item: Partial<MenuItem>): MenuItem {
    const action = this.inferItemAction(item);
    return {
      id: String(item.id || '').trim(),
      label: String(item.label || '').trim(),
      action,
      submenuId: action === 'submenu' ? String(item.submenuId || '').trim() : undefined,
      registrationPlan: action === 'registration' ? String(item.registrationPlan || 'basic').trim() : undefined,
      attendantType: action === 'attendant' ? String(item.attendantType || 'commercial').trim() : undefined,
      message: action === 'message' ? String(item.message || '').trim() : undefined
    };
  }

  private normalizeMenu(menu: Partial<Menu>): Menu {
    return {
      id: String(menu.id || '').trim(),
      title: String(menu.title || '').trim(),
      message: String(menu.message || '').trim(),
      items: Array.isArray(menu.items)
        ? menu.items.map(item => this.normalizeItem(item)).filter(item => item.id && item.label && item.action)
        : []
    };
  }

  createMenu(menu: Menu): boolean {
    const normalized = this.normalizeMenu(menu);
    if (!normalized.id || !normalized.title || !normalized.message) {
      return false;
    }
    if (this.menus.has(normalized.id)) {
      return false;
    }
    this.menus.set(normalized.id, normalized);
    this.saveMenusToFile();
    return true;
  }

  updateMenu(menuId: string, updates: Partial<Menu>): boolean {
    const menu = this.menus.get(menuId);
    if (!menu) {
      return false;
    }
    const updated = this.normalizeMenu({ ...menu, ...updates, id: menu.id });
    this.menus.set(menuId, updated);
    this.saveMenusToFile();
    return true;
  }

  deleteMenu(menuId: string): boolean {
    const result = this.menus.delete(menuId);
    if (result) {
      this.saveMenusToFile();
    }
    return result;
  }

  addItemToMenu(menuId: string, item: MenuItem): boolean {
    const menu = this.menus.get(menuId);
    if (!menu) {
      return false;
    }
    menu.items = menu.items || [];
    const normalized = this.normalizeItem(item);
    if (!normalized.id || !normalized.label || !normalized.action) {
      return false;
    }
    menu.items.push(normalized);
    this.saveMenusToFile();
    return true;
  }

  removeItemFromMenu(menuId: string, itemId: string): boolean {
    const menu = this.menus.get(menuId);
    if (!menu) {
      return false;
    }
    menu.items = menu.items.filter(item => item.id !== itemId);
    this.saveMenusToFile();
    return true;
  }

  updateMenuItem(menuId: string, itemId: string, updates: Partial<MenuItem>): boolean {
    const menu = this.menus.get(menuId);
    if (!menu || !menu.items) {
      return false;
    }
    
    const itemIndex = menu.items.findIndex(item => item.id === itemId);
    if (itemIndex === -1) {
      return false;
    }
    
    // Manter o ID original
    const updatedItem = this.normalizeItem({ ...menu.items[itemIndex], ...updates, id: itemId });
    menu.items[itemIndex] = updatedItem;
    this.saveMenusToFile();
    return true;
  }

  exportMenusAsJson(): string {
    return JSON.stringify(this.getAllMenus(), null, 2);
  }

  importMenusFromJson(jsonData: string): boolean {
    try {
      const parsed = JSON.parse(jsonData);
      if (!Array.isArray(parsed)) return false;

      this.menus.clear();
      for (const rawMenu of parsed) {
        const normalized = this.normalizeMenu(rawMenu);
        if (!normalized.id || !normalized.title || !normalized.message) {
          return false;
        }
        this.menus.set(normalized.id, normalized);
      }

      this.saveMenusToFile();
      return true;
    } catch (_error) {
      return false;
    }
  }
}

interface BotConfig {
  geminiApiKey: string;
  geminiModel: string;
  openaiApiKey: string;
  openaiModel: string;
  aiProvider: 'gemini' | 'openai';
  botContext: string;
  botName: string;
  adminPassword: string;
  notificationTargetPhone: string;
  notifyOnRegistration: boolean;
  notifyOnAttendantRequest: boolean;
  adminPhones: string[];
}

interface ConnectedUser {
  jid: string;
  name: string;
  lastMessage: string;
  lastMessageTime: number;
  messageCount: number;
  isBlocked: boolean;
}

export class AdminServer {
  private app: express.Application;
  private port: number;
  private configFile: string;
  private connectedUsers: Map<string, ConnectedUser> = new Map();
  private sock: WASocket | null = null;
  private onConfigChange: ((config: BotConfig) => void) | null = null;
  public attendanceManager: AttendanceManager = new AttendanceManager();
  public menuManager: MenuManager = new MenuManager();
  public userMonitor: UserMonitor = new UserMonitor();
  public blockedUsersManager: BlockedUsersManager = new BlockedUsersManager();
  public registrationHandler: RegistrationHandler = registrationHandlerInstance; // ✅ SINGLETON
  public messageTemplates: MessageTemplateManager = new MessageTemplateManager();

  constructor(port: number = 3000) {
    this.port = port;
    this.app = express();
    this.configFile = path.join(__dirname, '../config/bot-config.json');
    
    // CRÍTICO: Injetar BlockedUsersManager no UserMonitor
    this.userMonitor.setBlockedUsersManager(this.blockedUsersManager);
    
    // Debug: Confirmar carregamento de bloqueados
    console.log(`\n🔒 Sistema de Bloqueio Inicializado`);
    console.log(`   Bloqueados carregados: ${this.blockedUsersManager.getBlockedUsers().length}`);
    
    this.setupMiddleware();
    this.setupRoutes();
  }

  private syncUserConversationState(jid: string, menuId: string) {
    const existingUser = this.userMonitor.getUser(jid);
    if (existingUser) {
      this.userMonitor.updateUserMenu(jid, menuId);
      return;
    }

    this.userMonitor.registerUser(jid, 'Cliente', menuId);
  }

  private setupMiddleware() {
    this.app.use(cors());
    this.app.use(bodyParser.json({ limit: '10mb' }));
    this.app.use(bodyParser.urlencoded({ limit: '10mb', extended: true }));
    this.app.use(express.static(path.join(__dirname, '../public')));
  }

  private setupRoutes() {
    // GET config
    this.app.get('/api/config', (_req: Request, res: Response) => {
      try {
        const config = this.loadConfig();
        // Não retornar a senha ou API key completa
        res.json({
          geminiModel: config.geminiModel,
          openaiModel: config.openaiModel,
          aiProvider: config.aiProvider,
          botName: config.botName,
          botContext: config.botContext,
          notificationTargetPhone: config.notificationTargetPhone,
          notifyOnRegistration: config.notifyOnRegistration,
          notifyOnAttendantRequest: config.notifyOnAttendantRequest,
          adminPhones: config.adminPhones,
          geminiApiKeyConfigured: !!config.geminiApiKey,
          openaiApiKeyConfigured: !!config.openaiApiKey,
          adminPasswordSet: !!config.adminPassword
        });
      } catch (error) {
        res.status(500).json({ error: 'Erro ao carregar configuração' });
      }
    });

    // POST update config
    this.app.post('/api/config', (req: Request, res: Response) => {
      try {
        const config = this.mergeConfigUpdates(this.loadConfig(), req.body || {});
        this.saveConfig(config);
        
        // Chamar callback se configurado
        if (this.onConfigChange) {
          this.onConfigChange(config);
        }
        
        res.json({ success: true, message: 'Configuração atualizada com sucesso' });
      } catch (error) {
        res.status(500).json({ error: 'Erro ao atualizar configuração' });
      }
    });

    // GET templates de mensagens editaveis
    this.app.get('/api/messages/templates', (_req: Request, res: Response) => {
      try {
        return res.json({ success: true, ...this.messageTemplates.getAll() });
      } catch (_error) {
        return res.status(500).json({ error: 'Erro ao carregar templates de mensagens' });
      }
    });

    // PUT templates de mensagens editaveis
    this.app.put('/api/messages/templates', (req: Request, res: Response) => {
      try {
        const { templates } = req.body || {};
        if (!templates || typeof templates !== 'object') {
          return res.status(400).json({ error: 'templates e obrigatorio' });
        }
        const saved = this.messageTemplates.updateMany(templates);
        return res.json({ success: true, ...saved });
      } catch (_error) {
        return res.status(500).json({ error: 'Erro ao salvar templates de mensagens' });
      }
    });

    // GET connected users
    this.app.get('/api/users', (_req: Request, res: Response) => {
      try {
        const users = Array.from(this.connectedUsers.values()).map(user => {
          // Buscar atendente vinculado
          const activeSession = this.attendanceManager.getActiveSession(user.jid);
          let linkedAttendant = null;
          
          if (activeSession) {
            linkedAttendant = this.attendanceManager.getAttendantById(activeSession.attendantId);
          }
          
          return {
            jid: user.jid,
            name: user.name,
            lastMessage: user.lastMessage,
            lastMessageTime: user.lastMessageTime,
            messageCount: user.messageCount,
            isBlocked: user.isBlocked,
            linkedAttendant: linkedAttendant ? {
              id: linkedAttendant.id,
              name: linkedAttendant.name,
              status: linkedAttendant.status
            } : null
          };
        });
        res.json(users);
      } catch (error) {
        res.status(500).json({ error: 'Erro ao carregar usuários' });
      }
    });

    // POST block/unblock user
    this.app.post('/api/users/:jid/block', (req: Request, res: Response) => {
      try {
        const { jid } = req.params;
        const { block, reason } = req.body;
        const user = this.connectedUsers.get(jid);
        
        if (block) {
          // Bloquear usuário
          const success = this.blockedUsersManager.blockUser(jid, user?.name, reason);
          if (success) {
            // Atualizar também em connectedUsers
            if (user) {
              user.isBlocked = true;
              this.connectedUsers.set(jid, user);
            }
            res.json({ success: true, message: 'Usuário bloqueado com sucesso' });
          } else {
            res.status(400).json({ error: 'Usuário já está bloqueado' });
          }
        } else {
          // Desbloquear usuário
          const success = this.blockedUsersManager.unblockUser(jid);
          if (success) {
            // Atualizar também em connectedUsers
            if (user) {
              user.isBlocked = false;
              this.connectedUsers.set(jid, user);
            }
            res.json({ success: true, message: 'Usuário desbloqueado com sucesso' });
          } else {
            res.status(400).json({ error: 'Usuário não estava bloqueado' });
          }
        }
      } catch (error) {
        res.status(500).json({ error: 'Erro ao processar ação' });
      }
    });

    // GET blocked users list
    this.app.get('/api/blocked-users', (req: Request, res: Response) => {
      try {
        const blockedUsers = this.blockedUsersManager.getBlockedUsers();
        res.json(blockedUsers);
      } catch (error) {
        res.status(500).json({ error: 'Erro ao carregar usuários bloqueados' });
      }
    });

    // DELETE unblock user
    this.app.delete('/api/blocked-users/:jid', (req: Request, res: Response) => {
      try {
        const { jid } = req.params;
        const success = this.blockedUsersManager.unblockUser(jid);
        
        if (success) {
          // Atualizar também em connectedUsers
          const user = this.connectedUsers.get(jid);
          if (user) {
            user.isBlocked = false;
            this.connectedUsers.set(jid, user);
          }
          res.json({ success: true, message: 'Usuário desbloqueado com sucesso' });
        } else {
          res.status(404).json({ error: 'Usuário não encontrado na lista de bloqueados' });
        }
      } catch (error) {
        res.status(500).json({ error: 'Erro ao desbloquear usuário' });
      }
    });

    // POST remove user
    this.app.post('/api/users/:jid/remove', (req: Request, res: Response) => {
      try {
        const { jid } = req.params;
        this.connectedUsers.delete(jid);
        res.json({ success: true, message: 'Usuário removido da lista' });
      } catch (error) {
        res.status(500).json({ error: 'Erro ao remover usuário' });
      }
    });

    // POST send message to user
    this.app.post('/api/users/:jid/message', async (req: Request, res: Response) => {
      try {
        const { jid } = req.params;
        const { message } = req.body;
        
        if (!this.sock) {
          return res.status(500).json({ error: 'Bot não está conectado' });
        }
        
        await this.sock.sendMessage(jid, { text: message });
        res.json({ success: true, message: 'Mensagem enviada' });
      } catch (error) {
        res.status(500).json({ error: 'Erro ao enviar mensagem' });
      }
    });

    // GET user details
    this.app.get('/api/users/:jid/history', (req: Request, res: Response) => {
      try {
        const { jid } = req.params;
        const user = this.connectedUsers.get(jid);
        
        if (!user) {
          return res.status(404).json({ error: 'Usuário não encontrado' });
        }
        
        // Carregar histórico de chat se existir
        const chatHistoryDir = path.join(__dirname, '../chat_history');
        const safeFileName = jid.replace(/[@:]/g, '_').replace(/[^a-zA-Z0-9_]/g, '');
        const historyFile = path.join(chatHistoryDir, `${safeFileName}.json`);
        
        let history: any[] = [];
        if (fs.existsSync(historyFile)) {
          const data = fs.readFileSync(historyFile, 'utf-8');
          history = JSON.parse(data);
        }
        
        res.json({
          user,
          history: history.slice(-20) // Últimas 20 mensagens
        });
      } catch (error) {
        res.status(500).json({ error: 'Erro ao carregar histórico' });
      }
    });

    // GET bot status
    this.app.get('/api/status', (_req: Request, res: Response) => {
      res.json({
        connected: this.sock !== null,
        connectedUsersCount: this.connectedUsers.size,
        uptime: process.uptime()
      });
    });

    // Servir o painel HTML
    this.app.get('/', (_req: Request, res: Response) => {
      res.sendFile(path.join(__dirname, '../public/admin-modern.html'));
    });

    // Painel legado (fallback)
    this.app.get('/admin-legacy', (_req: Request, res: Response) => {
      res.sendFile(path.join(__dirname, '../public/admin.html'));
    });

    // Servir página do atendente
    this.app.get('/attendant', (_req: Request, res: Response) => {
      res.sendFile(path.join(__dirname, '../public/attendant.html'));
    });

    // Servir página de monitor de usuários
    this.app.get('/monitor', (_req: Request, res: Response) => {
      res.sendFile(path.join(__dirname, '../public/monitor.html'));
    });

    // ============ ROTAS DE ATENDIMENTO ============

    // GET lista de atendentes
    this.app.get('/api/attendance/attendants', (_req: Request, res: Response) => {
      try {
        const attendants = this.attendanceManager.getAllAttendants();
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.json(attendants);
      } catch (error) {
        res.status(500).json({ error: 'Erro ao carregar atendentes' });
      }
    });

    // POST criar nova sessão de atendimento
    this.app.post('/api/attendance/session', (req: Request, res: Response) => {
      try {
        const { clientJid, attendantId } = req.body;
        
        if (!clientJid || !attendantId) {
          return res.status(400).json({ error: 'clientJid e attendantId são obrigatórios' });
        }

        const session = this.attendanceManager.createSession(clientJid, attendantId);
        res.json(session);
      } catch (error) {
        res.status(500).json({ error: 'Erro ao criar sessão' });
      }
    });

    // POST criar sessão com roteamento automático (atendente menos ocupado)
    this.app.post('/api/attendance/auto-session', async (req: Request, res: Response) => {
      try {
        const { clientJid, clientName, priority, requestedSkill, reason, summary, tags } = req.body;

        if (!clientJid) {
          return res.status(400).json({ error: 'clientJid obrigatorio' });
        }

        const existingSession = this.attendanceManager.getActiveSession(clientJid);
        if (existingSession) {
          this.syncUserConversationState(clientJid, 'attendance_active');
          return res.status(400).json({ error: 'Cliente ja tem uma sessao ativa' });
        }

        if (this.attendanceManager.isInQueue(clientJid)) {
          const availableNow = this.attendanceManager.getLeastBusyAttendant(requestedSkill, priority || 'normal');
          if (availableNow) {
            this.attendanceManager.removeFromQueue(clientJid, 'assigned');
            const session = this.attendanceManager.createSession(clientJid, availableNow.id, {
              priority,
              requestedSkill,
              reason,
              summary,
              tags,
              assignedAt: Date.now()
            });
            if (this.sock) {
              await this.sock.sendMessage(clientJid, {
                text: this.getMessageTemplate(
                  'humanConnectedDefault',
                  'Voce foi conectado ao atendimento humano agora.'
                )
              });
            }
            this.syncUserConversationState(clientJid, 'attendance_active');
            return res.json({
              success: true,
              inQueue: false,
              session,
              attendant: {
                id: availableNow.id,
                name: availableNow.name,
                skills: availableNow.skills
              }
            });
          }

          const positionDetails = this.attendanceManager.getQueuePositionDetailed(clientJid);
          this.syncUserConversationState(clientJid, 'attendance_waiting');
          return res.status(202).json({
            success: true,
            inQueue: true,
            queuePosition: positionDetails?.position || 0,
            estimatedWaitMinutes: positionDetails?.estimatedWaitMinutes || 0,
            queueMessage: positionDetails?.message || '',
            queueEntryMessage: positionDetails
              ? this.attendanceManager.getQueueEntryMessage(
                positionDetails.position,
                positionDetails.remaining,
                positionDetails.estimatedWaitMinutes
              )
              : '',
            message: 'Cliente ja esta na fila de espera'
          });
        }

        const result = this.attendanceManager.createAutoSession(clientJid, clientName || 'Cliente', {
          priority,
          requestedSkill,
          reason,
          summary,
          tags
        });

        if (result.inQueue) {
          const positionDetails = this.attendanceManager.getQueuePositionDetailed(clientJid);
          if (this.sock && positionDetails) {
            await this.sock.sendMessage(clientJid, {
              text: this.attendanceManager.getQueueEntryMessage(
                positionDetails.position,
                positionDetails.remaining,
                positionDetails.estimatedWaitMinutes
              )
            });
          }

          this.syncUserConversationState(clientJid, 'attendance_waiting');

          return res.status(202).json({
            success: true,
            inQueue: true,
            queuePosition: positionDetails?.position || 0,
            estimatedWaitMinutes: positionDetails?.estimatedWaitMinutes || 0,
            queueMessage: positionDetails?.message || '',
            queueEntryMessage: positionDetails
              ? this.attendanceManager.getQueueEntryMessage(
                positionDetails.position,
                positionDetails.remaining,
                positionDetails.estimatedWaitMinutes
              )
              : '',
            message: 'Cliente adicionado a fila de espera'
          });
        }

        if (this.sock) {
          await this.sock.sendMessage(clientJid, {
            text: this.renderMessageTemplate(
              'humanForwardingNamed',
              { attendantName: result.attendant.name },
              'Perfeito! Seu atendimento esta sendo transferido para {attendantName}.'
            )
          });
        }

        this.syncUserConversationState(clientJid, 'attendance_active');

        res.json({
          success: true,
          inQueue: false,
          session: result.session,
          attendant: {
            id: result.attendant.id,
            name: result.attendant.name,
            skills: result.attendant.skills
          }
        });
      } catch (error) {
        console.error('Erro ao criar sessao automatica:', error);
        res.status(500).json({ error: 'Erro ao criar sessao' });
      }
    });

    // GET sessão ativa de um cliente
    this.app.get('/api/attendance/session/:clientJid', (req: Request, res: Response) => {
      try {
        const { clientJid } = req.params;
        const session = this.attendanceManager.getActiveSession(clientJid);
        
        if (!session) {
          return res.status(404).json({ error: 'Sessão não encontrada' });
        }

        res.json(session);
      } catch (error) {
        res.status(500).json({ error: 'Erro ao buscar sessão' });
      }
    });

    // GET histórico da sessão
    this.app.get('/api/attendance/session/:sessionId/history', (req: Request, res: Response) => {
      try {
        const { sessionId } = req.params;
        const history = this.attendanceManager.getSessionHistory(sessionId);
        res.json(history);
      } catch (error) {
        res.status(500).json({ error: 'Erro ao carregar histórico' });
      }
    });

    // GET contexto de handoff da sessão (IA -> humano)
    this.app.get('/api/attendance/session/:sessionId/handoff-context', (req: Request, res: Response) => {
      try {
        const { sessionId } = req.params;
        const context = this.attendanceManager.getSessionHandoffContext(sessionId, 30);
        if (!context) {
          return res.status(404).json({ error: 'Sessão não encontrada' });
        }
        res.json({ success: true, context });
      } catch (error) {
        res.status(500).json({ error: 'Erro ao carregar contexto de handoff' });
      }
    });

    // GET histórico completo do cliente (desde o início)
    this.app.get('/api/attendance/client/:clientJid/full-history', (req: Request, res: Response) => {
      try {
        const { clientJid } = req.params;
        
        // Carregar histórico de chat do arquivo se existir
        const chatHistoryDir = path.join(__dirname, '../chat_history');
        const safeFileName = clientJid.replace(/[@:]/g, '_').replace(/[^a-zA-Z0-9_-]/g, '');
        const historyFile = path.join(chatHistoryDir, `${safeFileName}.json`);
        
        let fullHistory: any[] = [];
        if (fs.existsSync(historyFile)) {
          const data = fs.readFileSync(historyFile, 'utf-8');
          fullHistory = JSON.parse(data);
        }
        
        // Também adicionar mensagens da sessão de atendimento atual
        const activeSession = this.attendanceManager.getActiveSession(clientJid);
        if (activeSession) {
          fullHistory = fullHistory.concat(activeSession.messages);
        }
        
        // Ordenar por timestamp
        fullHistory.sort((a, b) => a.timestamp - b.timestamp);
        
        res.json(fullHistory);
      } catch (error) {
        console.error('Erro ao carregar histórico completo:', error);
        res.status(500).json({ error: 'Erro ao carregar histórico' });
      }
    });

    // POST enviar mensagem na sessão
    this.app.post('/api/attendance/message', async (req: Request, res: Response) => {
      try {
        const { sessionId, message } = req.body;
        const safeMessage = (message || '').toString().trim();
        if (!safeMessage) {
          return res.status(400).json({ error: 'Mensagem vazia' });
        }
        const session = this.attendanceManager.getSessionById(sessionId);

        if (!session) {
          return res.status(404).json({ error: 'Sessão não encontrada' });
        }

        // Adicionar mensagem ao histórico
        this.attendanceManager.addMessageToSession(sessionId, 'attendant', safeMessage);

        // Enviar mensagem ao cliente via WhatsApp
        if (this.sock) {
          await this.sock.sendMessage(session.clientJid, { text: safeMessage });
        }

        res.json({ success: true, message: 'Mensagem enviada' });
      } catch (error) {
        res.status(500).json({ error: 'Erro ao enviar mensagem' });
      }
    });

    // POST alternar status do bot
    this.app.post('/api/attendance/session/:sessionId/bot-toggle', (req: Request, res: Response) => {
      try {
        const { sessionId } = req.params;
        const session = this.attendanceManager.getSessionById(sessionId);

        if (!session) {
          return res.status(404).json({ error: 'Sessão não encontrada' });
        }

        this.attendanceManager.toggleBotStatus(sessionId);
        res.json(session);
      } catch (error) {
        res.status(500).json({ error: 'Erro ao alternar bot' });
      }
    });

    // DELETE finalizar sessão
    this.app.delete('/api/attendance/session/:sessionId', async (req: Request, res: Response) => {
      try {
        const { sessionId } = req.params;
        const session = this.attendanceManager.getSessionById(sessionId);
        const { silent } = req.query;
        const isSilent = silent === 'true';
        const success = await this.attendanceManager.endSession(
          sessionId,
          isSilent,
          this.getMessageTemplate(
            'attendanceEndedDefault',
            'Atendimento finalizado. O bot foi reativado para responder automaticamente.'
          )
        );

        if (!success) {
          return res.status(404).json({ error: 'Sessão não encontrada' });
        }

        if (session?.clientJid) {
          this.syncUserConversationState(session.clientJid, 'main');
        }
        res.json({ success: true, message: 'Sessão finalizada' });
      } catch (error) {
        res.status(500).json({ error: 'Erro ao finalizar sessão' });
      }
    });

    // POST transferir sessão para outro atendente
    this.app.post('/api/attendance/session/:sessionId/transfer', async (req: Request, res: Response) => {
      try {
        const { sessionId } = req.params;
        const { targetAttendantId } = req.body;

        if (!targetAttendantId) {
          return res.status(400).json({ error: 'targetAttendantId e obrigatorio' });
        }

        const transferred = this.attendanceManager.transferSession(sessionId, targetAttendantId);
        if (!transferred.success) {
          return res.status(400).json({ error: transferred.error || 'Nao foi possivel transferir sessao' });
        }

        const session = transferred.session;
        const targetAttendant = this.attendanceManager.getAttendantById(targetAttendantId);
        if (this.sock && session && targetAttendant) {
          await this.sock.sendMessage(session.clientJid, {
            text: this.renderMessageTemplate(
              'humanForwardingNamed',
              { attendantName: targetAttendant.name },
              'Perfeito! Seu atendimento esta sendo transferido para {attendantName}.'
            )
          });
        }

        res.json({ success: true, session });
      } catch (error) {
        res.status(500).json({ error: 'Erro ao transferir sessao' });
      }
    });

    // GET histórico de números atendidos por atendente
    this.app.get('/api/attendance/attendant/:attendantId/history', (req: Request, res: Response) => {
      try {
        const { attendantId } = req.params;
        const items = this.attendanceManager.getAttendantConversationIndex(attendantId);
        res.json({ success: true, items });
      } catch (error) {
        res.status(500).json({ error: 'Erro ao carregar historico do atendente' });
      }
    });

    // GET histórico da conversa por número atendido
    this.app.get('/api/attendance/attendant/:attendantId/history/:clientJid', (req: Request, res: Response) => {
      try {
        const { attendantId, clientJid } = req.params;
        const messages = this.attendanceManager.getAttendantConversationHistory(attendantId, clientJid);
        res.json({ success: true, messages });
      } catch (error) {
        res.status(500).json({ error: 'Erro ao carregar conversa historica' });
      }
    });

    // POST adicionar novo atendente
    this.app.post('/api/attendance/attendants', (req: Request, res: Response) => {
      try {
        const { name, email, login, password, maxConcurrentChats } = req.body;

        if (!name || !email || !login || !password) {
          return res.status(400).json({ error: 'name, email, login e password são obrigatórios' });
        }

        // Verificar se login já existe
        if (this.attendanceManager.loginExists(login)) {
          return res.status(400).json({ error: 'Este login já está em uso' });
        }

        const attendant = this.attendanceManager.addAttendant(
          name,
          email,
          login,
          password,
          Number(maxConcurrentChats) > 0 ? Number(maxConcurrentChats) : undefined
        );
        res.json(attendant);
      } catch (error) {
        res.status(500).json({ error: 'Erro ao adicionar atendente' });
      }
    });

    // PUT atualizar atendente
    this.app.put('/api/attendance/attendants/:attendantId', (req: Request, res: Response) => {
      try {
        const { attendantId } = req.params;
        const { name, email, login, password, maxConcurrentChats } = req.body;

        if (!name || !email || !login) {
          return res.status(400).json({ error: 'name, email e login são obrigatórios' });
        }

        const attendant = this.attendanceManager.updateAttendant(
          attendantId,
          name,
          email,
          login,
          password,
          Number(maxConcurrentChats) > 0 ? Number(maxConcurrentChats) : undefined
        );

        if (!attendant) {
          return res.status(404).json({ error: 'Atendente não encontrado' });
        }

        res.json(attendant);
      } catch (error) {
        res.status(500).json({ error: 'Erro ao atualizar atendente' });
      }
    });

    // DELETE remover atendente
    this.app.delete('/api/attendance/attendants/:attendantId', (req: Request, res: Response) => {
      try {
        const { attendantId } = req.params;
        const success = this.attendanceManager.removeAttendant(attendantId);

        if (!success) {
          return res.status(404).json({ error: 'Atendente não encontrado' });
        }

        res.json({ success: true, message: 'Atendente removido' });
      } catch (error) {
        res.status(500).json({ error: 'Erro ao remover atendente' });
      }
    });

    // GET sessões ativas (opcionalmente filtradas por attendantId)
    this.app.get('/api/attendance/sessions', (req: Request, res: Response) => {
      try {
        const { attendantId } = req.query;
        
        let sessions = this.attendanceManager.getActiveSessions();
        
        // Se attendantId foi fornecido, filtrar as sessões
        if (attendantId) {
          sessions = sessions.filter(s => s.attendantId === attendantId);
        }
        
        // Enriquecer sessões com informações do cliente
        const enrichedSessions = sessions.map(session => ({
          ...session,
          clientName: session.clientJid.split('@')[0] || 'Cliente', // Extrair nome do JID
          lastMessage: session.messages && session.messages.length > 0
            ? session.messages[session.messages.length - 1].text.substring(0, 50)
            : 'Nenhuma mensagem',
          routing: {
            priority: session.handoff?.priority || 'normal',
            requestedSkill: session.handoff?.requestedSkill || null
          },
          sla: {
            firstResponseSeconds: session.metrics?.firstResponseSeconds ?? null,
            queueWaitSeconds: session.metrics?.queueWaitSeconds ?? null
          }
        }));
        
        res.json(enrichedSessions);
      } catch (error) {
        res.status(500).json({ error: 'Erro ao carregar sessões' });
      }
    });

    // GET fila de clientes aguardando atendimento
    this.app.get('/api/attendance/queue', (req: Request, res: Response) => {
      try {
        const queue = this.attendanceManager.getWaitingQueue();
        const queueSize = this.attendanceManager.getQueueSize();
        
        res.json({ 
          success: true, 
          queue: queue,
          totalWaiting: queueSize,
          estimatedWaitTime: queueSize > 0 ? `${Math.ceil(queueSize * 5)} minutos` : 'Nenhum cliente na fila'
        });
      } catch (error) {
        res.status(500).json({ error: 'Erro ao carregar fila' });
      }
    });

    // GET posição de um cliente na fila
    this.app.get('/api/attendance/queue/:clientJid', (req: Request, res: Response) => {
      try {
        const { clientJid } = req.params;
        const positionDetails = this.attendanceManager.getQueuePositionDetailed(clientJid);
        
        if (!positionDetails) {
          return res.status(404).json({ error: 'Cliente não encontrado na fila' });
        }

        const totalInQueue = this.attendanceManager.getQueueSize();
        const estimatedMinutesPerClient = 5;
        const estimatedWaitTime = Math.ceil((positionDetails.remaining + 1) * estimatedMinutesPerClient);

        res.json({ 
          success: true, 
          clientJid,
          position: positionDetails.position,
          positionText: `${positionDetails.position}º na fila`,
          remaining: positionDetails.remaining,
          remainingText: positionDetails.remaining === 0 
            ? 'Você é o próximo!' 
            : `Faltam ${positionDetails.remaining} pessoa${positionDetails.remaining > 1 ? 's' : ''}`,
          totalInQueue: totalInQueue,
          isNextInLine: positionDetails.isNextInLine,
          estimatedWaitTime: `${positionDetails.estimatedWaitMinutes || estimatedWaitTime} minutos`,
          friendlyMessage: positionDetails.message
        });
      } catch (error) {
        res.status(500).json({ error: 'Erro ao consultar posição na fila' });
      }
    });

    // DELETE remover cliente da fila
    this.app.delete('/api/attendance/queue/:clientJid', async (req: Request, res: Response) => {
      try {
        const { clientJid } = req.params;
        const removed = this.attendanceManager.removeFromQueue(clientJid, 'manual_remove');
        
        if (!removed) {
          return res.status(404).json({ error: 'Cliente não encontrado na fila' });
        }

        if (this.sock) {
          await this.sock.sendMessage(clientJid, {
            text: this.getMessageTemplate('queueRemovedByAdmin', 'Voce foi removido da fila de espera.')
          });
        }

        this.syncUserConversationState(clientJid, 'main');
        res.json({ success: true, message: 'Cliente removido da fila' });
      } catch (error) {
        res.status(500).json({ error: 'Erro ao remover cliente da fila' });
      }
    });

    // POST atendente puxa proximo cliente da fila
    this.app.post('/api/attendance/attendants/:attendantId/pull-next', async (req: Request, res: Response) => {
      try {
        const { attendantId } = req.params;
        const result = this.attendanceManager.pullNextFromQueueByAttendant(attendantId);
        if (!result.success) {
          return res.status(400).json({ error: result.error || 'Nao foi possivel iniciar atendimento da fila' });
        }

        if (this.sock && result.session && result.client) {
          const attendant = this.attendanceManager.getAttendantById(attendantId);
          await this.sock.sendMessage(result.client.clientJid, {
            text: this.renderMessageTemplate(
              'queueAssignedPullNext',
              { attendantName: attendant?.name || 'um atendente' },
              'Voce saiu da fila e seu atendimento foi iniciado com {attendantName}.'
            )
          });
        }

        if (result.client?.clientJid) {
          this.syncUserConversationState(result.client.clientJid, 'attendance_active');
        }
        return res.json({ success: true, session: result.session, client: result.client });
      } catch (error) {
        return res.status(500).json({ error: 'Erro ao iniciar atendimento da fila' });
      }
    });

    // POST atendente inicia atendimento de um cliente especifico da fila (forcado)
    this.app.post('/api/attendance/attendants/:attendantId/start-queued', async (req: Request, res: Response) => {
      try {
        const { attendantId } = req.params;
        const { clientJid } = req.body || {};
        if (!clientJid) {
          return res.status(400).json({ error: 'clientJid e obrigatorio' });
        }

        const result = this.attendanceManager.startQueuedClientByAttendant(attendantId, clientJid);
        if (!result.success) {
          return res.status(400).json({ error: result.error || 'Nao foi possivel iniciar atendimento da fila' });
        }

        if (this.sock && result.session && result.client) {
          const attendant = this.attendanceManager.getAttendantById(attendantId);
          await this.sock.sendMessage(result.client.clientJid, {
            text: this.renderMessageTemplate(
              'queueAssignedByAttendant',
              { attendantName: attendant?.name || 'um atendente' },
              'Seu atendimento foi iniciado com {attendantName}.'
            )
          });
        }

        if (result.client?.clientJid) {
          this.syncUserConversationState(result.client.clientJid, 'attendance_active');
        }
        return res.json({ success: true, session: result.session, client: result.client });
      } catch (error) {
        return res.status(500).json({ error: 'Erro ao iniciar atendimento da fila' });
      }
    });

    // POST login de atendente
    this.app.post('/api/attendance/login', (req: Request, res: Response) => {
      try {
        const { login, password } = req.body;

        if (!login || !password) {
          return res.status(400).json({ error: 'Login e senha são obrigatórios' });
        }

        const attendant = this.attendanceManager.authenticateAttendant(login, password);

        if (!attendant) {
          return res.status(401).json({ error: 'Login ou senha inválidos' });
        }

        this.attendanceManager.updateAttendantStatus(attendant.id, 'online');
        const refreshedAttendant = this.attendanceManager.getAttendantById(attendant.id) || attendant;
        res.json({ success: true, attendant: refreshedAttendant });
      } catch (error) {
        res.status(500).json({ error: 'Erro ao autenticar' });
      }
    });

    // PUT atualizar status do atendente
    this.app.put('/api/attendance/attendants/:attendantId/status', (req: Request, res: Response) => {
      try {
        const { attendantId } = req.params;
        const { status } = req.body;

        if (!status || !['online', 'busy', 'offline'].includes(status)) {
          return res.status(400).json({ error: 'Status inválido' });
        }

        const success = this.attendanceManager.updateAttendantStatus(attendantId, status as 'online' | 'busy' | 'offline');

        if (!success) {
          return res.status(404).json({ error: 'Atendente não encontrado' });
        }

        const attendant = this.attendanceManager.getAttendantById(attendantId);
        res.json({ success: true, attendant });
      } catch (error) {
        res.status(500).json({ error: 'Erro ao atualizar status' });
      }
    });

    // PUT perfil operacional do atendente (skills/capacidade)
    this.app.put('/api/attendance/attendants/:attendantId/profile', (req: Request, res: Response) => {
      try {
        const { attendantId } = req.params;
        const { skills, maxConcurrentChats, status } = req.body;
        const attendant = this.attendanceManager.updateAttendantProfile(attendantId, {
          skills: Array.isArray(skills) ? skills : undefined,
          maxConcurrentChats: Number(maxConcurrentChats) > 0 ? Number(maxConcurrentChats) : undefined,
          status
        });

        if (!attendant) {
          return res.status(404).json({ error: 'Atendente não encontrado' });
        }

        res.json({ success: true, attendant });
      } catch (error) {
        res.status(500).json({ error: 'Erro ao atualizar perfil do atendente' });
      }
    });

    // POST avaliacao de encerramento de atendimento
    this.app.post('/api/attendance/session/:sessionId/review', (req: Request, res: Response) => {
      try {
        const { sessionId } = req.params;
        const { nature, outcome, resolved, contracted, notes } = req.body || {};
        if (!nature || !outcome) {
          return res.status(400).json({ error: 'nature e outcome sao obrigatorios' });
        }

        const review = this.attendanceManager.saveSessionReview({
          sessionId,
          nature,
          outcome,
          resolved: Boolean(resolved),
          contracted: Boolean(contracted),
          notes
        });

        if (!review) {
          return res.status(404).json({ error: 'Sessao nao encontrada' });
        }

        return res.json({ success: true, review });
      } catch (error) {
        return res.status(500).json({ error: 'Erro ao salvar avaliacao da sessao' });
      }
    });

    // GET analise de conversas por tipo de atendimento
    this.app.get('/api/attendance/analytics/conversations', (req: Request, res: Response) => {
      try {
        const nature = typeof req.query.nature === 'string' && req.query.nature ? req.query.nature : undefined;
        const outcome = typeof req.query.outcome === 'string' && req.query.outcome ? req.query.outcome : undefined;
        const attendantId = typeof req.query.attendantId === 'string' && req.query.attendantId ? req.query.attendantId : undefined;
        const data = this.attendanceManager.getConversationAnalytics({ nature, outcome, attendantId });
        return res.json({ success: true, ...data });
      } catch (error) {
        return res.status(500).json({ error: 'Erro ao carregar analise de conversas' });
      }
    });

    // GET configuração global de concorrência de atendimento
    this.app.get('/api/attendance/settings/concurrency', (_req: Request, res: Response) => {
      try {
        const maxConcurrentChats = this.attendanceManager.getDefaultMaxConcurrentChats();
        res.json({ success: true, maxConcurrentChats });
      } catch (error) {
        res.status(500).json({ error: 'Erro ao carregar configuração de concorrência' });
      }
    });

    // PUT configuração global de concorrência de atendimento
    this.app.put('/api/attendance/settings/concurrency', (req: Request, res: Response) => {
      try {
        const { maxConcurrentChats, applyToAll } = req.body;
        if (!maxConcurrentChats || Number(maxConcurrentChats) < 1) {
          return res.status(400).json({ error: 'maxConcurrentChats deve ser maior que zero' });
        }

        const shouldApplyToAll = applyToAll === undefined ? true : Boolean(applyToAll);
        const saved = this.attendanceManager.setDefaultMaxConcurrentChats(Number(maxConcurrentChats), shouldApplyToAll);
        res.json({ success: true, maxConcurrentChats: saved, applyToAll: shouldApplyToAll });
      } catch (error) {
        res.status(500).json({ error: 'Erro ao salvar configuração de concorrência' });
      }
    });

    // GET textos dinamicos enviados ao cliente (fila/atendimento)
    this.app.get('/api/attendance/settings/messages', (_req: Request, res: Response) => {
      try {
        const messages = this.attendanceManager.getCustomerMessages();
        res.json({ success: true, messages });
      } catch (error) {
        res.status(500).json({ error: 'Erro ao carregar textos de atendimento' });
      }
    });

    // PUT textos dinamicos enviados ao cliente (fila/atendimento)
    this.app.put('/api/attendance/settings/messages', (req: Request, res: Response) => {
      try {
        const { messages } = req.body || {};
        if (!messages || typeof messages !== 'object') {
          return res.status(400).json({ error: 'messages e obrigatorio' });
        }
        const saved = this.attendanceManager.updateCustomerMessages(messages);
        return res.json({ success: true, messages: saved });
      } catch (error) {
        return res.status(500).json({ error: 'Erro ao salvar textos de atendimento' });
      }
    });

    // PUT prioridade de cliente na fila
    this.app.put('/api/attendance/queue/:clientJid/priority', (req: Request, res: Response) => {
      try {
        const { clientJid } = req.params;
        const { priority } = req.body;
        if (!priority || !['low', 'normal', 'high', 'urgent'].includes(priority)) {
          return res.status(400).json({ error: 'Prioridade inválida' });
        }

        const updated = this.attendanceManager.setQueuePriority(clientJid, priority);
        if (!updated) {
          return res.status(404).json({ error: 'Cliente não encontrado na fila' });
        }

        res.json({ success: true, message: 'Prioridade atualizada' });
      } catch (error) {
        res.status(500).json({ error: 'Erro ao atualizar prioridade da fila' });
      }
    });

    // GET indicadores de SLA de atendimento
    this.app.get('/api/attendance/sla', (_req: Request, res: Response) => {
      try {
        const snapshot = this.attendanceManager.getSlaSnapshot();
        res.json({ success: true, snapshot });
      } catch (error) {
        res.status(500).json({ error: 'Erro ao carregar indicadores de SLA' });
      }
    });

    // PUT metas de SLA
    this.app.put('/api/attendance/sla-targets', (req: Request, res: Response) => {
      try {
        const { firstResponseSeconds, queueWaitSeconds } = req.body;
        if (!firstResponseSeconds || !queueWaitSeconds) {
          return res.status(400).json({ error: 'firstResponseSeconds e queueWaitSeconds são obrigatórios' });
        }
        const targets = this.attendanceManager.setSlaTargets(Number(firstResponseSeconds), Number(queueWaitSeconds));
        res.json({ success: true, targets });
      } catch (error) {
        res.status(500).json({ error: 'Erro ao atualizar metas de SLA' });
      }
    });

    // GET macros versionadas e aprovadas para atendimento
    this.app.get('/api/attendance/macros', (_req: Request, res: Response) => {
      try {
        const macros = this.attendanceManager.getMacros();
        res.json({ success: true, macros });
      } catch (error) {
        res.status(500).json({ error: 'Erro ao carregar macros' });
      }
    });

    // POST criar/atualizar macro com versionamento
    this.app.post('/api/attendance/macros', (req: Request, res: Response) => {
      try {
        const { id, title, text, category, approved, updatedBy } = req.body;
        if (!id || !title || !text) {
          return res.status(400).json({ error: 'id, title e text são obrigatórios' });
        }
        const macro = this.attendanceManager.upsertMacro({ id, title, text, category, approved, updatedBy });
        res.json({ success: true, macro });
      } catch (error) {
        res.status(500).json({ error: 'Erro ao salvar macro' });
      }
    });

    // DELETE remover macro
    this.app.delete('/api/attendance/macros/:id', (req: Request, res: Response) => {
      try {
        const deleted = this.attendanceManager.deleteMacro(req.params.id);
        if (!deleted) {
          return res.status(404).json({ error: 'Macro não encontrada' });
        }
        res.json({ success: true, message: 'Macro removida' });
      } catch (error) {
        res.status(500).json({ error: 'Erro ao remover macro' });
      }
    });

    // ============ ROTAS DE GERENCIAMENTO DE MENUS ============
    
    // GET todos os menus
    this.app.get('/api/menus', (_req: Request, res: Response) => {
      try {
        const menus = this.menuManager.getAllMenus();
        res.json({ success: true, menus, count: menus.length });
      } catch (error) {
        res.status(500).json({ error: 'Erro ao carregar menus' });
      }
    });

    this.app.get('/api/menus/meta', (_req: Request, res: Response) => {
      try {
        res.json({ success: true, ...this.menuManager.getEditorMetadata() });
      } catch (error) {
        res.status(500).json({ error: 'Erro ao carregar metadados dos menus' });
      }
    });

    // GET um menu específico
    this.app.get('/api/menus/:menuId', (req: Request, res: Response) => {
      try {
        const { menuId } = req.params;
        const menu = this.menuManager.getMenu(menuId);
        if (!menu) {
          return res.status(404).json({ error: 'Menu não encontrado' });
        }
        res.json({ success: true, menu });
      } catch (error) {
        res.status(500).json({ error: 'Erro ao carregar menu' });
      }
    });

    // POST criar novo menu
    this.app.post('/api/menus', (req: Request, res: Response) => {
      try {
        const { id, title, message, items } = req.body;
        
        if (!id || !title || !message) {
          return res.status(400).json({ error: 'ID, título e mensagem são obrigatórios' });
        }

        const success = this.menuManager.createMenu({
          id,
          title,
          message,
          items: items || []
        });

        if (!success) {
          return res.status(400).json({ error: 'Erro ao criar menu. Verifique se o ID já existe.' });
        }

        res.json({ success: true, message: 'Menu criado com sucesso' });
      } catch (error) {
        res.status(500).json({ error: 'Erro ao criar menu' });
      }
    });

    // PUT atualizar menu
    this.app.put('/api/menus/:menuId', (req: Request, res: Response) => {
      try {
        const { menuId } = req.params;
        const { title, message, items } = req.body;

        const success = this.menuManager.updateMenu(menuId, {
          title,
          message,
          items
        });

        if (!success) {
          return res.status(400).json({ error: 'Erro ao atualizar menu' });
        }

        res.json({ success: true, message: 'Menu atualizado com sucesso' });
      } catch (error) {
        res.status(500).json({ error: 'Erro ao atualizar menu' });
      }
    });

    // DELETE remover menu
    this.app.delete('/api/menus/:menuId', (req: Request, res: Response) => {
      try {
        const { menuId } = req.params;

        const success = this.menuManager.deleteMenu(menuId);

        if (!success) {
          return res.status(400).json({ error: 'Erro ao deletar menu. Verifique se há referências.' });
        }

        res.json({ success: true, message: 'Menu deletado com sucesso' });
      } catch (error) {
        res.status(500).json({ error: 'Erro ao deletar menu' });
      }
    });

    // POST adicionar item a um menu
    this.app.post('/api/menus/:menuId/items', (req: Request, res: Response) => {
      try {
        const { menuId } = req.params;
        const item = req.body;

        if (!item.id || !item.label) {
          return res.status(400).json({ error: 'ID e label do item são obrigatórios' });
        }

        const success = this.menuManager.addItemToMenu(menuId, item);

        if (!success) {
          return res.status(400).json({ error: 'Erro ao adicionar item' });
        }

        res.json({ success: true, message: 'Item adicionado com sucesso' });
      } catch (error) {
        res.status(500).json({ error: 'Erro ao adicionar item' });
      }
    });

    // DELETE remover item de um menu
    this.app.delete('/api/menus/:menuId/items/:itemId', (req: Request, res: Response) => {
      try {
        const { menuId, itemId } = req.params;

        const success = this.menuManager.removeItemFromMenu(menuId, itemId);

        if (!success) {
          return res.status(400).json({ error: 'Erro ao remover item' });
        }

        res.json({ success: true, message: 'Item removido com sucesso' });
      } catch (error) {
        res.status(500).json({ error: 'Erro ao remover item' });
      }
    });

    // PUT atualizar item de um menu
    this.app.put('/api/menus/:menuId/items/:itemId', (req: Request, res: Response) => {
      try {
        const { menuId, itemId } = req.params;
        const updates = req.body;

        const success = this.menuManager.updateMenuItem(menuId, itemId, updates);

        if (!success) {
          return res.status(400).json({ error: 'Erro ao atualizar item' });
        }

        res.json({ success: true, message: 'Item atualizado com sucesso' });
      } catch (error) {
        res.status(500).json({ error: 'Erro ao atualizar item' });
      }
    });

    // GET exportar todos os menus como JSON
    this.app.get('/api/menus/export/json', (_req: Request, res: Response) => {
      try {
        const jsonData = this.menuManager.exportMenusAsJson();
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', 'attachment; filename=menus.json');
        res.send(jsonData);
      } catch (error) {
        res.status(500).json({ error: 'Erro ao exportar menus' });
      }
    });

    // POST importar menus de JSON
    this.app.post('/api/menus/import/json', (req: Request, res: Response) => {
      try {
        const { jsonData } = req.body;

        if (!jsonData) {
          return res.status(400).json({ error: 'Dados JSON são obrigatórios' });
        }

        const success = this.menuManager.importMenusFromJson(jsonData);

        if (!success) {
          return res.status(400).json({ error: 'Erro ao importar menus. Verifique o formato JSON.' });
        }

        res.json({ success: true, message: 'Menus importados com sucesso' });
      } catch (error) {
        res.status(500).json({ error: 'Erro ao importar menus' });
      }
    });

    // ============ ROTAS DE MONITORAMENTO DE USUÁRIOS ============

    // GET usuários online com localização no menu
    this.app.get('/api/monitor/online-users', (_req: Request, res: Response) => {
      try {
        const users = this.userMonitor.getAllOnlineUsers();
        res.json({ success: true, users, count: users.length });
      } catch (error) {
        res.status(500).json({ error: 'Erro ao carregar usuários online' });
      }
    });

    // GET usuários por menu específico
    this.app.get('/api/monitor/users-by-menu/:menuId', (req: Request, res: Response) => {
      try {
        const { menuId } = req.params;
        const users = this.userMonitor.getUsersByMenu(menuId);
        res.json({ success: true, users, count: users.length });
      } catch (error) {
        res.status(500).json({ error: 'Erro ao carregar usuários' });
      }
    });

    // GET estatísticas de monitoramento
    this.app.get('/api/monitor/statistics', (_req: Request, res: Response) => {
      try {
        const stats = this.userMonitor.getStatistics();
        res.json({ success: true, stats });
      } catch (error) {
        res.status(500).json({ error: 'Erro ao carregar estatísticas' });
      }
    });

    // POST registrar usuário como online
    this.app.post('/api/monitor/register-user', (req: Request, res: Response) => {
      try {
        const { jid, name, currentMenu } = req.body;
        
        if (!jid || !name) {
          return res.status(400).json({ error: 'jid e name são obrigatórios' });
        }

        const user = this.userMonitor.registerUser(jid, name, currentMenu || 'main');
        res.json({ success: true, user });
      } catch (error) {
        res.status(500).json({ error: 'Erro ao registrar usuário' });
      }
    });

    // POST atualizar menu do usuário
    this.app.post('/api/monitor/update-user-menu', (req: Request, res: Response) => {
      try {
        const { jid, menuId } = req.body;
        
        if (!jid || !menuId) {
          return res.status(400).json({ error: 'jid e menuId são obrigatórios' });
        }

        const success = this.userMonitor.updateUserMenu(jid, menuId);
        res.json({ success, message: 'Menu atualizado' });
      } catch (error) {
        res.status(500).json({ error: 'Erro ao atualizar menu' });
      }
    });

    // POST bloquear usuário
    this.app.post('/api/monitor/block-user', async (req: Request, res: Response) => {
      try {
        const { jid, adminId, reason } = req.body;
        
        if (!jid || !adminId) {
          return res.status(400).json({ error: 'jid e adminId são obrigatórios' });
        }

        const action = await this.userMonitor.blockUser(jid, adminId, reason);
        res.json({ success: true, action });
      } catch (error) {
        res.status(500).json({ error: 'Erro ao bloquear usuário' });
      }
    });

    // POST desbloquear usuário
    this.app.post('/api/monitor/unblock-user', async (req: Request, res: Response) => {
      try {
        const { jid, adminId } = req.body;
        
        if (!jid || !adminId) {
          return res.status(400).json({ error: 'jid e adminId são obrigatórios' });
        }

        const action = await this.userMonitor.unblockUser(jid, adminId);
        res.json({ success: true, action });
      } catch (error) {
        res.status(500).json({ error: 'Erro ao desbloquear usuário' });
      }
    });

    // POST intervir em atendimento de usuário
    this.app.post('/api/monitor/intervene-user', async (req: Request, res: Response) => {
      try {
        const { jid, adminId, adminName } = req.body;
        
        if (!jid || !adminId || !adminName) {
          return res.status(400).json({ error: 'jid, adminId e adminName são obrigatórios' });
        }

        const action = await this.userMonitor.interveneUser(jid, adminId, adminName);
        res.json({ success: true, action });
      } catch (error) {
        res.status(500).json({ error: 'Erro ao intervir' });
      }
    });

    // POST resetar sessão do usuário
    this.app.post('/api/monitor/reset-session', async (req: Request, res: Response) => {
      try {
        const { jid, adminId } = req.body;
        
        if (!jid || !adminId) {
          return res.status(400).json({ error: 'jid e adminId são obrigatórios' });
        }

        const action = await this.userMonitor.resetUserSession(jid, adminId);
        res.json({ success: true, action });
      } catch (error) {
        res.status(500).json({ error: 'Erro ao resetar sessão' });
      }
    });

    // POST entrar em contato direto com usuário
    this.app.post('/api/monitor/contact-user', async (req: Request, res: Response) => {
      try {
        const { jid, adminId, adminName, message } = req.body;
        
        if (!jid || !adminId || !adminName || !message) {
          return res.status(400).json({ error: 'jid, adminId, adminName e message são obrigatórios' });
        }

        const action = await this.userMonitor.contactUser(jid, adminId, adminName, message);
        res.json({ success: true, action });
      } catch (error) {
        res.status(500).json({ error: 'Erro ao enviar mensagem' });
      }
    });

    // POST remover usuário (kick)
    this.app.post('/api/monitor/kick-user', async (req: Request, res: Response) => {
      try {
        const { jid, adminId, reason } = req.body;
        
        if (!jid || !adminId) {
          return res.status(400).json({ error: 'jid e adminId são obrigatórios' });
        }

        const action = await this.userMonitor.kickUser(jid, adminId, reason);
        res.json({ success: true, action });
      } catch (error) {
        res.status(500).json({ error: 'Erro ao remover usuário' });
      }
    });

    // GET histórico de ações
    this.app.get('/api/monitor/action-history', (req: Request, res: Response) => {
      try {
        const limit = parseInt(req.query.limit as string) || 100;
        const history = this.userMonitor.getActionHistory(limit);
        res.json({ success: true, history, count: history.length });
      } catch (error) {
        res.status(500).json({ error: 'Erro ao carregar histórico' });
      }
    });

    // GET ações de um usuário específico
    this.app.get('/api/monitor/user/:jid/actions', (req: Request, res: Response) => {
      try {
        const { jid } = req.params;
        const actions = this.userMonitor.getUserActions(jid);
        res.json({ success: true, actions, count: actions.length });
      } catch (error) {
        res.status(500).json({ error: 'Erro ao carregar ações do usuário' });
      }
    });

    // POST limpar usuários inativos
    this.app.post('/api/monitor/clear-inactive', (req: Request, res: Response) => {
      try {
        const minutes = parseInt(req.body.minutes) || 30;
        const removed = this.userMonitor.clearInactiveUsers(minutes);
        res.json({ success: true, removed });
      } catch (error) {
        res.status(500).json({ error: 'Erro ao limpar usuários inativos' });
      }
    });

    // GET detalhes de um usuário
    this.app.get('/api/monitor/user/:jid', (req: Request, res: Response) => {
      try {
        const { jid } = req.params;
        const user = this.userMonitor.getUser(jid);
        
        if (!user) {
          return res.status(404).json({ error: 'Usuário não encontrado' });
        }

        res.json({ success: true, user });
      } catch (error) {
        res.status(500).json({ error: 'Erro ao carregar detalhes do usuário' });
      }
    });

    // GET histórico de conversa do cliente (NEW)
    this.app.get('/api/monitor/user/:jid/chat-history', (req: Request, res: Response) => {
      try {
        const { jid } = req.params;
        
        // Carregar histórico de chat do arquivo se existir
        const chatHistoryDir = path.join(__dirname, '../chat_history');
        const safeFileName = jid.replace(/[@:]/g, '_').replace(/[^a-zA-Z0-9_-]/g, '');
        const historyFile = path.join(chatHistoryDir, `${safeFileName}.json`);
        
        let history: any[] = [];
        if (fs.existsSync(historyFile)) {
          try {
            const data = fs.readFileSync(historyFile, 'utf-8');
            history = JSON.parse(data);
          } catch (parseError) {
            console.error('Erro ao parsear arquivo de histórico:', parseError);
          }
        }
        
        // Também adicionar mensagens da sessão de atendimento atual
        const activeSession = this.attendanceManager.getActiveSession(jid);
        if (activeSession && activeSession.messages) {
          history = history.concat(activeSession.messages);
        }
        
        // Ordenar por timestamp
        history.sort((a, b) => {
          const timeA = a.timestamp || a.time || 0;
          const timeB = b.timestamp || b.time || 0;
          return timeA - timeB;
        });
        
        res.json({ 
          success: true, 
          history: history,
          count: history.length
        });
      } catch (error) {
        console.error('Erro ao carregar histórico de chat:', error);
        res.status(500).json({ error: 'Erro ao carregar histórico de conversa' });
      }
    });

    this.app.get('/api/dashboard/summary', (_req: Request, res: Response) => {
      try {
        const users = Array.from(this.connectedUsers.values());
        const menus = this.menuManager.getAllMenus();
        const registrations = this.registrationHandler.getAllRegistrations();
        const sessions = this.attendanceManager.getActiveSessions();
        const queue = this.attendanceManager.getWaitingQueue();
        const attendants = this.attendanceManager.getAllAttendants();
        const monitorStats = this.userMonitor.getStatistics();
        const sla = this.attendanceManager.getSlaSnapshot();
        const bot = botStatus.getStatus();

        const pendingRegistrations = registrations.filter(reg => reg.status === 'pending');
        const registrationEvents = registrations
          .flatMap(reg => (Array.isArray((reg as any).history) ? (reg as any).history.slice(-3).map((entry: any) => ({
            timestamp: entry.timestamp,
            icon: entry.type === 'approved'
              ? 'check-circle'
              : entry.type === 'rejected'
                ? 'ban'
                : entry.type === 'updated'
                  ? 'pen-to-square'
                  : 'clipboard-list',
            title: reg.clientName || reg.clientPhone || 'Cliente',
            description: entry.summary
          })) : []))
          .sort((a, b) => b.timestamp - a.timestamp)
          .slice(0, 6);

        const botEvents = bot.changeLog
          .slice(-4)
          .reverse()
          .map(entry => ({
            timestamp: entry.timestamp,
            icon: entry.status === 'enabled' ? 'power-off' : 'pause-circle',
            title: `Bot ${entry.status === 'enabled' ? 'ativado' : 'desativado'}`,
            description: `Alterado por ${entry.admin}`
          }));

        const insights: string[] = [];
        if (!bot.enabled) insights.push('O bot esta desativado e nao respondera automaticamente novos clientes.');
        if (queue.length > 0) insights.push(`Ha ${queue.length} cliente(s) aguardando atendimento humano na fila.`);
        if (pendingRegistrations.length > 0) insights.push(`${pendingRegistrations.length} cadastro(s) ainda precisam de validacao administrativa.`);
        if (sla.queue.waitingNow > 0 && sla.response.avgQueueWaitSeconds > sla.targets.queueWaitSeconds) {
          insights.push('O tempo medio de espera da fila esta acima da meta definida.');
        }
        if (attendants.filter((att: any) => att.status === 'online').length === 0) {
          insights.push('Nenhum atendente esta disponivel online neste momento.');
        }
        if (insights.length === 0) {
          insights.push('Operacao estavel. Sem gargalos criticos detectados no momento.');
        }

        res.json({
          success: true,
          metrics: {
            connectedUsers: users.length,
            totalMenus: menus.length,
            pendingRegistrations: pendingRegistrations.length,
            activeSessions: sessions.length,
            onlineAttendants: attendants.filter((att: any) => att.status === 'online').length,
            busyAttendants: attendants.filter((att: any) => att.status === 'busy').length,
            queueSize: queue.length,
            blockedUsers: this.blockedUsersManager.getBlockedUsers().length
          },
          health: {
            botEnabled: bot.enabled,
            queueWaitingNow: sla.queue.waitingNow,
            averageFirstResponseSeconds: sla.response.avgFirstResponseSeconds,
            averageQueueWaitSeconds: sla.response.avgQueueWaitSeconds,
            targetFirstResponseSeconds: sla.targets.firstResponseSeconds,
            targetQueueWaitSeconds: sla.targets.queueWaitSeconds
          },
          insights,
          activities: [...registrationEvents, ...botEvents].sort((a, b) => b.timestamp - a.timestamp).slice(0, 8),
          monitor: monitorStats,
          recentRegistrations: this.registrationHandler.getRecentRegistrations(5)
        });
      } catch (error) {
        res.status(500).json({ error: 'Erro ao carregar resumo do dashboard' });
      }
    });

    // ============ ROTAS DE REGISTROS ============

    // GET todos os registros
    this.app.get('/api/registrations', (_req: Request, res: Response) => {
      try {
        const registrations = this.registrationHandler.getAllRegistrations();
        res.json(registrations);
      } catch (error) {
        console.error('❌ [API] Erro ao carregar registros:', error);
        res.status(500).json({ error: 'Erro ao carregar registros' });
      }
    });

    // GET registro específico
    this.app.get('/api/registrations/:registrationId', (req: Request, res: Response) => {
      try {
        const { registrationId } = req.params;
        const registration = this.registrationHandler.getRegistration(registrationId);
        
        if (!registration) {
          return res.status(404).json({ error: 'Registro não encontrado' });
        }

        res.json(registration);
      } catch (error) {
        res.status(500).json({ error: 'Erro ao carregar registro' });
      }
    });

    // POST criar novo registro
    this.app.post('/api/registrations', (req: Request, res: Response) => {
      try {
        const payload = req.body || {};
        const clientJid = this.resolveClientJid(payload);
        const clientName = this.resolveClientName(payload);
        const clientPhone = this.asTrimmedString(payload.clientPhone || payload.phone);
        const clientEmail = this.asTrimmedString(payload.clientEmail || payload.email);
        const document = this.asTrimmedString(payload.document);
        const address = this.asTrimmedString(payload.address);
        const plan = this.asTrimmedString(payload.plan) || 'basic';
        const additionalInfo = this.asTrimmedString(payload.additionalInfo);
        const internalNotes = this.asTrimmedString(payload.internalNotes);

        if (!clientJid) {
          return res.status(400).json({ error: 'clientJid é obrigatório' });
        }

        if (!clientName) {
          return res.status(400).json({ error: 'clientName é obrigatório (ou forneça fullName/businessName/ownerName)' });
        }

        const registration = this.registrationHandler.createRegistration(clientJid, clientName, {
          clientPhone,
          clientEmail,
          document,
          address,
          plan: plan || 'basic',
          additionalInfo,
          internalNotes
        });

        res.json({ success: true, registration });
      } catch (error) {
        res.status(500).json({ error: 'Erro ao criar registro' });
      }
    });

    // PUT atualizar registro
    this.app.put('/api/registrations/:registrationId', (req: Request, res: Response) => {
      try {
        const { registrationId } = req.params;
        const updates = {
          ...req.body,
          updatedBy: this.asTrimmedString(req.body?.updatedBy) || 'admin'
        };

        const success = this.registrationHandler.updateRegistration(registrationId, updates);
        
        if (!success) {
          return res.status(404).json({ error: 'Registro não encontrado' });
        }

        res.json({ success: true });
      } catch (error) {
        res.status(500).json({ error: 'Erro ao atualizar registro' });
      }
    });

    // POST aprovar registro
    this.app.post('/api/registrations/:registrationId/approve', (req: Request, res: Response) => {
      try {
        const { registrationId } = req.params;
        const { approvedBy } = req.body;

        const success = this.registrationHandler.approveRegistration(registrationId, approvedBy || 'admin');
        
        if (!success) {
          return res.status(404).json({ error: 'Registro não encontrado' });
        }

        const registration = this.registrationHandler.getRegistration(registrationId);
        res.json({ success: true, registration });
      } catch (error) {
        res.status(500).json({ error: 'Erro ao aprovar registro' });
      }
    });

    // POST rejeitar registro
    this.app.post('/api/registrations/:registrationId/reject', (req: Request, res: Response) => {
      try {
        const { registrationId } = req.params;
        const { reason } = req.body;

        const success = this.registrationHandler.rejectRegistration(registrationId, reason || 'Sem motivo especificado');
        
        if (!success) {
          return res.status(404).json({ error: 'Registro não encontrado' });
        }

        const registration = this.registrationHandler.getRegistration(registrationId);
        res.json({ success: true, registration });
      } catch (error) {
        res.status(500).json({ error: 'Erro ao rejeitar registro' });
      }
    });

    // DELETE remover registro
    this.app.delete('/api/registrations/:registrationId', (req: Request, res: Response) => {
      try {
        const { registrationId } = req.params;
        const success = this.registrationHandler.deleteRegistration(registrationId);
        
        if (!success) {
          return res.status(404).json({ error: 'Registro não encontrado' });
        }

        res.json({ success: true });
      } catch (error) {
        res.status(500).json({ error: 'Erro ao remover registro' });
      }
    });

    // GET registros por status
    this.app.get('/api/registrations/status/:status', (req: Request, res: Response) => {
      try {
        const { status } = req.params;
        const registrations = this.registrationHandler.getRegistrationsByStatus(status as any);
        res.json(registrations);
      } catch (error) {
        res.status(500).json({ error: 'Erro ao carregar registros' });
      }
    });

    // GET estatísticas de registros
    this.app.get('/api/registrations/stats/overview', (_req: Request, res: Response) => {
      try {
        const stats = this.registrationHandler.getRegistrationStats();
        res.json(stats);
      } catch (error) {
        res.status(500).json({ error: 'Erro ao carregar estatísticas' });
      }
    });

    // GET registros recentes
    this.app.get('/api/registrations/recent/:limit', (req: Request, res: Response) => {
      try {
        const limit = parseInt(req.params.limit) || 10;
        const registrations = this.registrationHandler.getRecentRegistrations(limit);
        res.json(registrations);
      } catch (error) {
        res.status(500).json({ error: 'Erro ao carregar registros recentes' });
      }
    });

    // GET planos de registro
    this.app.get('/api/registration-plans', (_req: Request, res: Response) => {
      try {
        const plans = this.registrationHandler.getAllPlans();
        res.json(plans);
      } catch (error) {
        res.status(500).json({ error: 'Erro ao carregar planos' });
      }
    });

    // GET planos ativos
    this.app.get('/api/registration-plans/active', (_req: Request, res: Response) => {
      try {
        const plans = this.registrationHandler.getActivePlans();
        res.json(plans);
      } catch (error) {
        res.status(500).json({ error: 'Erro ao carregar planos' });
      }
    });

    // GET plano específico
    this.app.get('/api/registration-plans/:planId', (req: Request, res: Response) => {
      try {
        const { planId } = req.params;
        const plan = this.registrationHandler.getPlan(planId);
        
        if (!plan) {
          return res.status(404).json({ error: 'Plano não encontrado' });
        }

        res.json(plan);
      } catch (error) {
        res.status(500).json({ error: 'Erro ao carregar plano' });
      }
    });

    // ============ ROTAS DE CONTROLE DO BOT ============

    // GET status do bot
    this.app.get('/api/bot-status', (_req: Request, res: Response) => {
      try {
        const status = botStatus.getStatus();
        res.json({ 
          success: true, 
          ...status 
        });
      } catch (error) {
        res.status(500).json({ error: 'Erro ao obter status do bot' });
      }
    });

    // POST desativar o bot
    this.app.post('/api/bot-control/disable', (req: Request, res: Response) => {
      try {
        const { adminId = 'admin' } = req.body;
        const wasDisabled = botStatus.disableBot(adminId);
        
        res.json({ 
          success: true, 
          message: wasDisabled ? 'Bot desativado com sucesso' : 'Bot já estava desativado',
          currentStatus: botStatus.getStatus()
        });
      } catch (error) {
        res.status(500).json({ error: 'Erro ao desativar bot' });
      }
    });

    // POST ativar o bot
    this.app.post('/api/bot-control/enable', (req: Request, res: Response) => {
      try {
        const { adminId = 'admin' } = req.body;
        const wasEnabled = botStatus.enableBot(adminId);
        
        res.json({ 
          success: true, 
          message: wasEnabled ? 'Bot ativado com sucesso' : 'Bot já estava ativado',
          currentStatus: botStatus.getStatus()
        });
      } catch (error) {
        res.status(500).json({ error: 'Erro ao ativar bot' });
      }
    });

    // POST alternar status do bot
    this.app.post('/api/bot-control/toggle', (req: Request, res: Response) => {
      try {
        const { adminId = 'admin' } = req.body;
        botStatus.toggleBot(adminId);
        
        res.json({ 
          success: true, 
          message: botStatus.isEnabled() ? 'Bot ativado' : 'Bot desativado',
          currentStatus: botStatus.getStatus()
        });
      } catch (error) {
        res.status(500).json({ error: 'Erro ao alternar status do bot' });
      }
    });

    // GET histórico de mudanças do bot
    this.app.get('/api/bot-control/history', (req: Request, res: Response) => {
      try {
        const limit = parseInt(req.query.limit as string) || 50;
        const history = botStatus.getChangeHistory(limit);
        
        res.json({ 
          success: true, 
          history
        });
      } catch (error) {
        res.status(500).json({ error: 'Erro ao obter histórico' });
      }
    });

    // POST criar novo plano
    this.app.post('/api/registration-plans', (req: Request, res: Response) => {
      try {
        const plan = this.normalizePlanPayload(req.body);

        if (!plan) {
          return res.status(400).json({ error: 'Plano inválido. Verifique id, name e fields' });
        }

        const success = this.registrationHandler.createPlan(plan);
        
        if (!success) {
          return res.status(400).json({ error: 'Plano com esse ID já existe' });
        }

        res.json({ success: true });
      } catch (error) {
        res.status(500).json({ error: 'Erro ao criar plano' });
      }
    });

    // PUT atualizar plano
    this.app.put('/api/registration-plans/:planId', (req: Request, res: Response) => {
      try {
        const { planId } = req.params;
        const updates = this.normalizePlanUpdates(req.body);

        if (Object.keys(updates).length === 0) {
          return res.status(400).json({ error: 'Nenhuma atualização válida foi informada' });
        }

        const success = this.registrationHandler.updatePlan(planId, updates);
        
        if (!success) {
          return res.status(404).json({ error: 'Plano não encontrado' });
        }

        res.json({ success: true });
      } catch (error) {
        res.status(500).json({ error: 'Erro ao atualizar plano' });
      }
    });

    // DELETE remover plano
    this.app.delete('/api/registration-plans/:planId', (req: Request, res: Response) => {
      try {
        const { planId } = req.params;
        const success = this.registrationHandler.deletePlan(planId);
        
        if (!success) {
          return res.status(404).json({ error: 'Plano não encontrado' });
        }

        res.json({ success: true });
      } catch (error) {
        res.status(500).json({ error: 'Erro ao remover plano' });
      }
    });
  }

  private asTrimmedString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  private isInvalidClientName(value: string): boolean {
    const normalized = value.trim().toLowerCase();
    return !normalized
      || normalized === 'sem nome'
      || normalized === 'waiting'
      || normalized.startsWith('waiting_')
      || normalized.includes('waiting_name');
  }

  private resolveClientJid(payload: any): string {
    const direct = this.asTrimmedString(payload.clientJid);
    if (direct) return direct;

    const phoneAsJid = this.asTrimmedString(payload.clientPhone || payload.phone || payload.whatsapp);
    if (phoneAsJid.includes('@')) return phoneAsJid;
    return '';
  }

  private resolveClientName(payload: any): string {
    const candidates: string[] = [];
    const addCandidate = (value: unknown) => {
      const text = this.asTrimmedString(value);
      if (text) candidates.push(text);
    };

    addCandidate(payload.clientName);
    addCandidate(payload.name);
    addCandidate(payload.fullName);
    addCandidate(payload.businessName);
    addCandidate(payload.ownerName);
    addCandidate(payload.contactName);

    const formData = payload.formData;
    if (formData && typeof formData === 'object') {
      addCandidate(formData.clientName);
      addCandidate(formData.name);
      addCandidate(formData.fullName);
      addCandidate(formData.businessName);
      addCandidate(formData.ownerName);
      addCandidate(formData.nome);
      addCandidate(formData.nomeCompleto);
      addCandidate(formData.razaoSocial);
    }

    const additionalInfo = this.asTrimmedString(payload.additionalInfo);
    if (additionalInfo) {
      const responsibleMatch = additionalInfo.match(/Respons[aá]vel:\s*(.+)/i);
      if (responsibleMatch?.[1]) {
        addCandidate(responsibleMatch[1].split('\n')[0]);
      }
    }

    return candidates.find(name => !this.isInvalidClientName(name)) || '';
  }

  private normalizePlanFields(rawFields: unknown): RegistrationField[] {
    const source = typeof rawFields === 'string'
      ? (() => {
          try {
            return JSON.parse(rawFields);
          } catch (_error) {
            return [];
          }
        })()
      : rawFields;

    if (!Array.isArray(source)) {
      return [];
    }

    const allowedTypes: RegistrationField['type'][] = ['text', 'email', 'phone', 'number', 'textarea', 'select'];

    return source
      .map((field, index) => {
        if (!field || typeof field !== 'object') return null;

        const name = this.asTrimmedString((field as any).name) || `field_${index + 1}`;
        const label = this.asTrimmedString((field as any).label) || name;
        const rawType = this.asTrimmedString((field as any).type).toLowerCase() as RegistrationField['type'];
        const type = allowedTypes.includes(rawType) ? rawType : 'text';
        const required = Boolean((field as any).required);
        const placeholder = this.asTrimmedString((field as any).placeholder);
        const options = Array.isArray((field as any).options)
          ? (field as any).options
              .map((opt: unknown) => this.asTrimmedString(opt))
              .filter((opt: string) => opt.length > 0)
          : undefined;

        const normalizedField: RegistrationField = { name, label, type, required };
        if (placeholder) normalizedField.placeholder = placeholder;
        if (type === 'select' && options && options.length > 0) normalizedField.options = options;

        return normalizedField;
      })
      .filter((field): field is RegistrationField => Boolean(field));
  }

  private normalizePlanPayload(rawPlan: any): RegistrationPlan | null {
    if (!rawPlan || typeof rawPlan !== 'object') return null;

    const id = this.asTrimmedString(rawPlan.id);
    const name = this.asTrimmedString(rawPlan.name);
    const fields = this.normalizePlanFields(rawPlan.fields);

    if (!id || !name || fields.length === 0) {
      return null;
    }

    return {
      id,
      name,
      description: this.asTrimmedString(rawPlan.description),
      active: typeof rawPlan.active === 'boolean' ? rawPlan.active : true,
      fields
    };
  }

  private normalizePlanUpdates(rawUpdates: any): Partial<RegistrationPlan> {
    if (!rawUpdates || typeof rawUpdates !== 'object') return {};

    const updates: Partial<RegistrationPlan> = {};
    const name = this.asTrimmedString(rawUpdates.name);
    const description = this.asTrimmedString(rawUpdates.description);

    if (name) updates.name = name;
    if (description || rawUpdates.description === '') updates.description = description;
    if (typeof rawUpdates.active === 'boolean') updates.active = rawUpdates.active;
    if (rawUpdates.fields !== undefined) {
      const fields = this.normalizePlanFields(rawUpdates.fields);
      if (fields.length > 0) updates.fields = fields;
    }

    return updates;
  }

  private loadConfig(): BotConfig {
    try {
      if (fs.existsSync(this.configFile)) {
        const data = fs.readFileSync(this.configFile, 'utf-8');
        return this.normalizeConfig(JSON.parse(data));
      }
    } catch (error) {
      console.error('Erro ao carregar config:', error);
    }
    
    return this.getDefaultConfig();
  }

  private saveConfig(config: BotConfig) {
    const configDir = path.dirname(this.configFile);
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    fs.writeFileSync(this.configFile, JSON.stringify(this.normalizeConfig(config), null, 2));
  }

  private getDefaultConfig(): BotConfig {
    return {
      geminiApiKey: '',
      geminiModel: 'gemini-1.5-flash',
      openaiApiKey: '',
      openaiModel: 'gpt-4-turbo',
      aiProvider: 'gemini',
      botContext: 'Você é um assistente helpful e amável.',
      botName: 'WhatsApp Bot',
      adminPassword: '',
      notificationTargetPhone: '',
      notifyOnRegistration: false,
      notifyOnAttendantRequest: false,
      adminPhones: []
    };
  }

  private normalizePhoneInput(value: unknown): string {
    return String(value || '').replace(/\D/g, '').trim();
  }

  private normalizeAdminPhones(values: unknown): string[] {
    if (!Array.isArray(values)) return [];

    const unique = new Set<string>();
    for (const value of values) {
      const digits = this.normalizePhoneInput(value);
      if (!digits) continue;
      unique.add(digits);
    }

    return Array.from(unique);
  }

  private normalizeConfig(rawConfig: Partial<BotConfig> | null | undefined): BotConfig {
    const defaults = this.getDefaultConfig();
    const source = rawConfig || {};

    return {
      geminiApiKey: typeof source.geminiApiKey === 'string' ? source.geminiApiKey : defaults.geminiApiKey,
      geminiModel: typeof source.geminiModel === 'string' && source.geminiModel.trim() ? source.geminiModel.trim() : defaults.geminiModel,
      openaiApiKey: typeof source.openaiApiKey === 'string' ? source.openaiApiKey : defaults.openaiApiKey,
      openaiModel: typeof source.openaiModel === 'string' && source.openaiModel.trim() ? source.openaiModel.trim() : defaults.openaiModel,
      aiProvider: source.aiProvider === 'openai' ? 'openai' : 'gemini',
      botContext: typeof source.botContext === 'string' ? source.botContext : defaults.botContext,
      botName: typeof source.botName === 'string' && source.botName.trim() ? source.botName.trim() : defaults.botName,
      adminPassword: typeof source.adminPassword === 'string' ? source.adminPassword : defaults.adminPassword,
      notificationTargetPhone: this.normalizePhoneInput(source.notificationTargetPhone),
      notifyOnRegistration: typeof source.notifyOnRegistration === 'boolean' ? source.notifyOnRegistration : defaults.notifyOnRegistration,
      notifyOnAttendantRequest: typeof source.notifyOnAttendantRequest === 'boolean' ? source.notifyOnAttendantRequest : defaults.notifyOnAttendantRequest,
      adminPhones: source.adminPhones !== undefined
        ? this.normalizeAdminPhones(source.adminPhones)
        : this.normalizeAdminPhones(defaults.adminPhones)
    };
  }

  private mergeConfigUpdates(currentConfig: BotConfig, updates: any): BotConfig {
    const merged: BotConfig = { ...currentConfig };

    if (updates.geminiApiKey !== undefined && updates.geminiApiKey !== '') merged.geminiApiKey = updates.geminiApiKey;
    if (updates.geminiModel !== undefined) merged.geminiModel = updates.geminiModel;
    if (updates.openaiApiKey !== undefined && updates.openaiApiKey !== '') merged.openaiApiKey = updates.openaiApiKey;
    if (updates.openaiModel !== undefined) merged.openaiModel = updates.openaiModel;
    if (updates.aiProvider !== undefined) merged.aiProvider = updates.aiProvider;
    if (updates.botContext !== undefined) merged.botContext = updates.botContext;
    if (updates.botName !== undefined) merged.botName = updates.botName;
    if (updates.adminPassword !== undefined && updates.adminPassword !== '') merged.adminPassword = updates.adminPassword;
    if (updates.notificationTargetPhone !== undefined) merged.notificationTargetPhone = updates.notificationTargetPhone;
    if (updates.notifyOnRegistration !== undefined) merged.notifyOnRegistration = !!updates.notifyOnRegistration;
    if (updates.notifyOnAttendantRequest !== undefined) merged.notifyOnAttendantRequest = !!updates.notifyOnAttendantRequest;
    if (updates.adminPhones !== undefined) merged.adminPhones = Array.isArray(updates.adminPhones) ? updates.adminPhones : [];

    return this.normalizeConfig(merged);
  }

  public setSocket(sock: WASocket) {
    this.sock = sock;
    this.attendanceManager.setSocket(sock);
    this.userMonitor.setSocket(sock);
  }

  public addOrUpdateUser(jid: string, name: string, lastMessage: string) {
    const existingUser: ConnectedUser = this.connectedUsers.get(jid) || {
      jid,
      name,
      messageCount: 0,
      isBlocked: false,
      lastMessage: '',
      lastMessageTime: 0
    };
    
    existingUser.lastMessage = lastMessage;
    existingUser.lastMessageTime = Date.now();
    existingUser.messageCount++;
    
    this.connectedUsers.set(jid, existingUser);
  }

  public removeUser(jid: string) {
    this.connectedUsers.delete(jid);
  }

  public setConfigChangeCallback(callback: (config: BotConfig) => void) {
    this.onConfigChange = callback;
  }

  public start() {
    this.app.listen(this.port, () => {
      console.log(`\n🎛️  Painel Administrativo rodando em http://localhost:${this.port}`);
      console.log(`📱 Acesse em seu navegador para gerenciar o bot\n`);
    });
  }

  public getConfig(): BotConfig {
    return this.loadConfig();
  }

  public getMessageTemplate(key: string, fallback?: string): string {
    return this.messageTemplates.get(key, fallback);
  }

  public renderMessageTemplate(
    key: string,
    variables?: Record<string, string | number>,
    fallback?: string
  ): string {
    return this.messageTemplates.render(key, variables, fallback);
  }

  public isUserBlocked(jid: string): boolean {
    // Verificar no blockedUsersManager (fonte de verdade)
    const blocked = this.blockedUsersManager.isBlocked(jid);
    
    // Debug: Log quando alguém está bloqueado
    if (blocked) {
      const blockedUser = this.blockedUsersManager.getBlockedUser(jid);
      console.log(`🚫 [BLOQUEIO ATIVO] ${jid} - ${blockedUser?.name || 'Desconhecido'}`);
    }
    
    return blocked;
  }
}
