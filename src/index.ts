// Carregar variáveis de ambiente
import * as dotenv from 'dotenv';
dotenv.config();

import type { WASocket, proto } from 'baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import * as fs from 'fs';
import * as path from 'path';
import { AdminServer } from './admin-server';
import MenuManager, { MenuLevel, MenuItem } from './menu-manager';
import RegistrationSystem from './registration-system';
import { RegistrationHandler, RegistrationData, registrationHandlerInstance } from './registration-handler';
import MenuSystem from './menu-system';
import { UserMonitor } from './user-monitor';
import { botStatus } from './bot-status';

// Instancia global do gerenciador de registros (SINGLETON - mesmo em todo app)
const registrationHandler = registrationHandlerInstance;

// Diretório para salvar a autenticação
const authDir = path.join(__dirname, '../auth');

const LEGACY_ADMIN_PHONE = '557182547726';

// Função para limpar pasta de autenticação
function clearAuthFolder() {
  try {
    if (fs.existsSync(authDir)) {
      const files = fs.readdirSync(authDir);
      files.forEach((file) => {
        const filePath = path.join(authDir, file);
        if (fs.lstatSync(filePath).isDirectory()) {
          fs.rmSync(filePath, { recursive: true, force: true });
        } else {
          fs.unlinkSync(filePath);
        }
      });
      console.log(' Pasta de autenticação limpa!');
    }
  } catch (error) {
    console.error('Erro ao limpar pasta de autenticação:', error);
  }
}

// Função para garantir que o diretório existe
if (!fs.existsSync(authDir)) {
  fs.mkdirSync(authDir, { recursive: true });
}

// Inicializar servidor administrativo
const adminServer = new AdminServer(3000);

function tpl(
  key: string,
  fallback: string,
  variables?: Record<string, string | number>
): string {
  return adminServer.renderMessageTemplate(key, variables, fallback);
}

// Variável para armazenar o socket
let sock: WASocket | null = null;

// Acesso ao gerenciador de atendimento
let attendanceManager: any = null;

// Acesso ao monitor de usuários
let userMonitor: UserMonitor | null = null;

// Variável de controle de reconexão
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 3;
let isReconnecting = false;
let lastReconnectAt = 0;
const RECONNECT_COOLDOWN_MS = 4000;
let sessionResetCount = 0;

// Sistema para evitar processar multiplas mensagens simultaneas (offline/sincronizacao)
const messageDebounce = new Map<string, NodeJS.Timeout>();
const DEBOUNCE_DELAY = 2000; // 2 segundos para agrupar mensagens
const menuNavigationHistory = new Map<string, string[]>();

// Função auxiliar para aguardar um tempo
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

type BaileysModule = typeof import('baileys');
let baileysModulePromise: Promise<BaileysModule> | null = null;

function loadBaileys(): Promise<BaileysModule> {
  if (!baileysModulePromise) {
    baileysModulePromise = new Function("return import('baileys')")() as Promise<BaileysModule>;
  }
  return baileysModulePromise;
}

async function sendStructuredMessage(jid: string, content: any): Promise<void> {
  await sock!.sendMessage(jid, content as any);
}

function normalizePhoneDigits(value: string | number | undefined | null): string {
  const digits = String(value || '').replace(/\D/g, '').trim();
  if (!digits) return '';
  if (digits.startsWith('55')) return digits;
  if (digits.length === 10 || digits.length === 11) return `55${digits}`;
  return digits;
}

function jidToPhoneDigits(jid: string): string {
  return normalizePhoneDigits((jid || '').split('@')[0]);
}

function phoneToJid(phone: string): string | null {
  const digits = normalizePhoneDigits(phone);
  return digits ? `${digits}@s.whatsapp.net` : null;
}

function getRuntimeConfig() {
  return adminServer.getConfig();
}

function getConfiguredAdminPhones(): string[] {
  const config = getRuntimeConfig();
  const source = Array.isArray(config.adminPhones) ? config.adminPhones : [LEGACY_ADMIN_PHONE];

  return Array.from(new Set(source.map(phone => normalizePhoneDigits(phone)).filter(Boolean)));
}

function isAdminControlJid(remoteJid: string): boolean {
  return getConfiguredAdminPhones().includes(jidToPhoneDigits(remoteJid));
}

async function sendOperationalNotification(
  type: 'registration' | 'attendant',
  message: string
): Promise<void> {
  const config = getRuntimeConfig();
  const enabled = type === 'registration'
    ? config.notifyOnRegistration
    : config.notifyOnAttendantRequest;

  if (!enabled) return;

  const targetJid = phoneToJid(config.notificationTargetPhone);
  if (!targetJid || !sock) return;

  try {
    await sock.sendMessage(targetJid, { text: message });
    console.log(`[NOTIFICACAO] Aviso de ${type} enviado para ${targetJid}`);
  } catch (error) {
    console.error(`[NOTIFICACAO] Falha ao enviar aviso de ${type}:`, error);
  }
}

function getMenuById(menuId: string): any | null {
  const freshMenuManager = new MenuManager();
  return freshMenuManager.getMenu(menuId) || MenuSystem.getMenu(menuId);
}

function findMenuItemLocation(itemId: string): { menuId: string; menu: any; item: any } | null {
  const freshMenuManager = new MenuManager();
  const menuIds = new Set<string>([
    ...freshMenuManager.getAllMenus().map(menu => menu.id),
    ...MenuSystem.getAllMenuIds()
  ]);

  for (const menuId of menuIds) {
    const menu = freshMenuManager.getMenu(menuId) || MenuSystem.getMenu(menuId);
    if (!menu) continue;
    const item = menu.items.find((entry: any) => entry.id === itemId);
    if (item) {
      return { menuId, menu, item };
    }
  }

  return null;
}

function buildNumberedOptions(items: Array<{ label?: string; title?: string; description?: string }>): string {
  return items
    .map((item, index) => {
      const title = (item.label || item.title || '').trim();
      const description = (item.description || '').trim();
      return description
        ? `${index + 1}. ${title} - ${description}`
        : `${index + 1}. ${title}`;
    })
    .join('\n');
}

function getNumericChoice(text: string, max: number): number | null {
  const value = text.trim();
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  if (parsed < 1 || parsed > max) return null;
  return parsed;
}

function getMenuHistory(remoteJid: string): string[] {
  return menuNavigationHistory.get(remoteJid) || [];
}

function resetMenuHistory(remoteJid: string): void {
  menuNavigationHistory.set(remoteJid, []);
}

function pushMenuHistory(remoteJid: string, menuId: string): void {
  const history = getMenuHistory(remoteJid);
  if (!menuId || menuId === 'main') return;
  if (history[history.length - 1] === menuId) return;
  menuNavigationHistory.set(remoteJid, [...history, menuId].slice(-10));
}

function popPreviousMenu(remoteJid: string): string | null {
  const history = [...getMenuHistory(remoteJid)];
  const previous = history.pop() || null;
  menuNavigationHistory.set(remoteJid, history);
  return previous;
}

function buildRenderableMenu(remoteJid: string, menuId: string): any | null {
  const baseMenu = getMenuById(menuId);
  if (!baseMenu) return null;

  const clonedItems = Array.isArray(baseMenu.items)
    ? baseMenu.items.map((item: any) => ({ ...item }))
    : [];

  if (menuId !== 'main') {
    const previousMenuId = getMenuHistory(remoteJid).slice(-1)[0];
    if (previousMenuId) {
      clonedItems.push({
        id: '__menu_back',
        label: '↩️ Voltar ao menu anterior',
        action: 'submenu',
        submenuId: previousMenuId
      });
    }

    clonedItems.push({
      id: '__menu_home',
      label: '🏠 Voltar ao menu principal',
      action: 'submenu',
      submenuId: 'main'
    });
  }

  return {
    ...baseMenu,
    items: clonedItems
  };
}

function buildNavigationHint(remoteJid: string, menuId: string): string {
  const menu = buildRenderableMenu(remoteJid, menuId);
  if (!menu || !Array.isArray(menu.items)) {
    return 'Digite "menu" para voltar ao menu principal.';
  }

  const navItems = menu.items.filter((item: any) => item.id === '__menu_back' || item.id === '__menu_home');
  if (navItems.length === 0) {
    return 'Digite "menu" para voltar ao menu principal.';
  }

  const lines = ['Escolha como deseja continuar:'];
  for (const item of navItems) {
    const index = menu.items.findIndex((entry: any) => entry.id === item.id);
    if (index >= 0) {
      lines.push(`${index + 1}. ${item.label}`);
    }
  }

  lines.push('');
  lines.push('Ou digite "menu" para voltar ao menu principal.');
  return lines.join('\n');
}

async function startHumanAttendance(
  remoteJid: string,
  clientName: string,
  context: { reason: string; summary: string; tags: string[] },
  messages?: {
    connected?: string;
    alreadyActive?: string;
  }
): Promise<{ status: 'queue' | 'active' }> {
  console.log(`[ATENDIMENTO] Solicitacao humana recebida de ${remoteJid}`);
  console.log(`[ATENDIMENTO] Motivo: ${context.reason}`);

  const existingSession = attendanceManager?.getActiveSession(remoteJid);
  if (existingSession) {
    console.log(`[ATENDIMENTO] Cliente ${remoteJid} ja possui sessao ativa (${existingSession.sessionId})`);
    userMonitor?.updateUserMenu(remoteJid, 'attendance_active');
    await sock!.sendMessage(remoteJid, {
      text: messages?.alreadyActive || tpl('humanConnectedDefault', '🤝 Voce ja esta em atendimento humano. Envie sua mensagem que a equipe vai responder por aqui.')
    });
    return { status: 'active' };
  }

  if (attendanceManager?.isInQueue(remoteJid)) {
    const availableNow = attendanceManager.getLeastBusyAttendant?.(undefined, 'normal');
    if (availableNow) {
      attendanceManager.removeFromQueue(remoteJid, 'assigned');
      attendanceManager.createSession(remoteJid, availableNow.id, {
        reason: context.reason,
        summary: context.summary,
        tags: context.tags,
        assignedAt: Date.now()
      });
      console.log(`[ATENDIMENTO] Cliente ${remoteJid} saiu da fila e foi conectado com ${availableNow.name}`);
      userMonitor?.updateUserMenu(remoteJid, 'attendance_active');
      await sock!.sendMessage(remoteJid, {
        text: messages?.connected || tpl('humanConnectedDefault', '🤝 Voce foi encaminhado para um atendente. Em breve nossa equipe respondera sua mensagem.')
      });
      return { status: 'active' };
    }

    const queueDetails = attendanceManager.getQueuePositionDetailed(remoteJid);
    console.log(`[ATENDIMENTO] Cliente ${remoteJid} ja estava na fila. Posicao atual: ${queueDetails?.position || 0}`);
    userMonitor?.updateUserMenu(remoteJid, 'attendance_waiting');
    await sock!.sendMessage(remoteJid, {
      text: queueDetails
        ? attendanceManager.getQueueEntryMessage(
          queueDetails.position,
          queueDetails.remaining,
          queueDetails.estimatedWaitMinutes
        )
        : tpl('queuePendingFallback', 'Seu pedido de atendimento ja foi registrado. Aguarde que nossa equipe vai falar com voce por aqui.')
    });
    return { status: 'queue' };
  }

  const result = attendanceManager?.createAutoSession(remoteJid, clientName || 'Cliente', {
    reason: context.reason,
    summary: context.summary,
    tags: context.tags
  });

  if (!result) {
    throw new Error('AttendanceManager indisponivel para criar atendimento');
  }

  if (result.inQueue) {
    const queueDetails = attendanceManager.getQueuePositionDetailed(remoteJid);
    console.log(`[ATENDIMENTO] Cliente ${remoteJid} entrou na fila. Posicao: ${queueDetails?.position || 0}`);
    userMonitor?.updateUserMenu(remoteJid, 'attendance_waiting');
    await sendOperationalNotification(
      'attendant',
      buildAttendantNotificationMessage(remoteJid, clientName, context, 'queue')
    );
    await sock!.sendMessage(remoteJid, {
      text: queueDetails
        ? attendanceManager.getQueueEntryMessage(
          queueDetails.position,
          queueDetails.remaining,
          queueDetails.estimatedWaitMinutes
        )
        : tpl('queuePendingFallback', 'Seu pedido de atendimento ja foi registrado. Aguarde que nossa equipe vai falar com voce por aqui.')
    });
    return { status: 'queue' };
  }

  const attendantName = result.attendant?.name || 'nosso especialista';
  const connectedText = messages?.connected
    ? messages.connected.replace(/\{attendantName\}/g, attendantName)
    : tpl(
      'humanForwardingNamed',
      'Perfeito! Seu atendimento esta sendo transferido para {attendantName}.',
      { attendantName }
    );

  console.log(`[ATENDIMENTO] Sessao humana criada para ${remoteJid} com atendente ${result.attendant?.name || result.session?.attendantId || 'desconhecido'}`);
  userMonitor?.updateUserMenu(remoteJid, 'attendance_active');
  await sendOperationalNotification(
    'attendant',
    buildAttendantNotificationMessage(remoteJid, clientName, context, 'active')
  );
  await sock!.sendMessage(remoteJid, {
    text: connectedText
  });
  return { status: 'active' };
}

const REGISTRATION_NICHES = [
  ' Pizzaria',
  ' Açaíteria',
  ' Lanchonete',
  ' Restaurante',
  ' Confeitaria',
  ' Saudável',
  ' Sushi Bar',
  ' Mexicano',
  ' Italiana',
  ' Café',
  ' Sucos/Bebidas',
  ' Marmitaria'
];

const REGISTRATION_SERVICES = [
  { id: 'service_0', name: ' Retirada', value: 'retirada' },
  { id: 'service_1', name: ' Delivery', value: 'delivery' },
  { id: 'service_2', name: ' Atendimento Local', value: 'local' },
  { id: 'service_3', name: ' Retirada +  Delivery', value: 'retirada,delivery' },
  { id: 'service_4', name: ' Retirada +  Atendimento Local', value: 'retirada,local' },
  { id: 'service_5', name: ' Delivery +  Atendimento Local', value: 'delivery,local' },
  { id: 'service_6', name: ' Retirada +  Delivery +  Atendimento Local', value: 'retirada,delivery,local' }
];

function hasStoredAuthState(): boolean {
  try {
    const credsPath = path.join(authDir, 'creds.json');
    return fs.existsSync(credsPath) && fs.statSync(credsPath).size > 0;
  } catch (_error) {
    return false;
  }
}

function canAttemptReconnect(): boolean {
  const now = Date.now();
  if ((now - lastReconnectAt) < RECONNECT_COOLDOWN_MS) {
    return false;
  }
  lastReconnectAt = now;
  return true;
}

async function restartSocketSession(options?: {
  clearAuth?: boolean;
  reason?: string;
  delayMs?: number;
}): Promise<void> {
  if (isReconnecting) return;

  isReconnecting = true;

  try {
    if (options?.reason) {
      console.log(`\n️ ${options.reason}`);
    }

    if (options?.clearAuth) {
      clearAuthFolder();
    }

    try {
      await sock?.ws.close();
    } catch (_error) {
      // Ignorar falhas ao encerrar socket atual.
    }

    sock = null;

    if ((options?.delayMs || 0) > 0) {
      await wait(options!.delayMs!);
    }

    await startSocket();
  } finally {
    isReconnecting = false;
  }
}

function mojibakeScore(text: string): number {
  const matches = text.match(/[\u00e2\u00f0\ufffd]/g);
  return matches ? matches.length : 0;
}

function normalizePossiblyBrokenText(text: string): string {
  if (!text || !/[ï¿½ï¿½ï¿½ï¿½]/.test(text)) return text;

  try {
    const decoded = Buffer.from(text, 'latin1').toString('utf8');
    if (!decoded) return text;
    return mojibakeScore(decoded) < mojibakeScore(text) ? decoded : text;
  } catch (_error) {
    return text;
  }
}

function normalizeOutboundContent(value: any): any {
  if (typeof value === 'string') {
    return normalizePossiblyBrokenText(value);
  }

  if (Array.isArray(value)) {
    return value.map(item => normalizeOutboundContent(item));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return value;
  }

  const normalized: Record<string, any> = {};
  for (const [key, fieldValue] of Object.entries(value)) {
    normalized[key] = normalizeOutboundContent(fieldValue);
  }
  return normalized;
}

function patchSocketTextNormalization(socket: WASocket): void {
  const anySocket = socket as any;
  if (anySocket.__textNormalizationPatched) return;

  const originalSendMessage = socket.sendMessage.bind(socket);
  anySocket.sendMessage = async (jid: string, content: any, options?: any) => {
    const normalizedContent = normalizeOutboundContent(content);
    return originalSendMessage(jid, normalizedContent, options);
  };

  anySocket.__textNormalizationPatched = true;
}

function isPlaceholderRegistrationValue(value?: string): boolean {
  const normalized = (value || '').trim().toLowerCase();
  return !normalized
    || normalized === 'waiting'
    || normalized.startsWith('waiting_')
    || normalized.includes('waiting_name');
}

function resolveFinalClientName(finalizedReg: any, fallbackContact: string): string {
  const candidates = [
    finalizedReg?.name,
    finalizedReg?.storeName,
    fallbackContact,
    finalizedReg?.clientPhone,
    'Cliente'
  ];

  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const text = candidate.trim();
    if (!text || isPlaceholderRegistrationValue(text)) continue;
    return text;
  }

  return 'Cliente';
}

function formatPlanLabel(planId?: string): string {
  const map: Record<string, string> = {
    basic: 'Plano Basico',
    professional: 'Plano Profissional'
  };
  return map[(planId || '').trim().toLowerCase()] || (planId || 'Plano nao informado');
}

function buildRegistrationNotificationMessage(savedRegistration: any, finalizedReg: any, contactName: string): string {
  const clientName = resolveFinalClientName(finalizedReg, contactName);
  const lines = [
    '📥 Novo cadastro concluido no Cardapio JK',
    '',
    `Cliente: ${clientName}`,
    `Plano: ${formatPlanLabel(finalizedReg?.plan || savedRegistration?.plan)}`,
    `WhatsApp: ${finalizedReg?.phone || savedRegistration?.clientPhone || jidToPhoneDigits(finalizedReg?.clientJid || savedRegistration?.clientJid || '') || '-'}`,
    `Email: ${finalizedReg?.email || savedRegistration?.clientEmail || '-'}`,
    `Loja: ${finalizedReg?.storeName || '-'}`,
    `Nicho: ${finalizedReg?.niche || '-'}`,
    `Origem: ${finalizedReg?.clientJid || savedRegistration?.clientJid || '-'}`
  ];

  return lines.join('\n');
}

function buildAttendantNotificationMessage(
  remoteJid: string,
  clientName: string,
  context: { reason: string; summary: string; tags: string[] },
  status: 'queue' | 'active'
): string {
  const queueOrSession = status === 'queue' ? 'entrou na fila de atendimento' : 'foi conectado ao atendimento';
  const safeName = (clientName || '').trim() || 'Cliente';

  return [
    '📞 Nova solicitacao de atendimento humano',
    '',
    `Cliente: ${safeName}`,
    `WhatsApp: ${jidToPhoneDigits(remoteJid) || remoteJid}`,
    `Status: ${queueOrSession}`,
    `Motivo: ${context.reason || '-'}`,
    `Resumo: ${context.summary || '-'}`,
    `Tags: ${(context.tags || []).filter(Boolean).join(', ') || '-'}`
  ].join('\n');
}

function buildAttendantRequestContext(params: {
  sourceArea: string;
  menuId?: string;
  menuTitle?: string;
  itemId?: string;
  itemLabel?: string;
  command?: string;
  extra?: string;
}): { reason: string; summary: string; tags: string[] } {
  const sourceArea = (params.sourceArea || 'desconhecido').trim();
  const menuId = (params.menuId || '').trim();
  const menuTitle = (params.menuTitle || '').trim();
  const itemId = (params.itemId || '').trim();
  const itemLabel = (params.itemLabel || '').trim();
  const command = (params.command || '').trim();
  const extra = (params.extra || '').trim();

  const areaLabelMap: Record<string, string> = {
    menu: 'Menu principal',
    cadastro: 'Fluxo de cadastro',
    registration: 'Fluxo de cadastro',
    upgrade: 'Fluxo de upgrade',
    faq: 'FAQ',
    desconhecido: 'Origem nao identificada'
  };

  const areaLabel = areaLabelMap[sourceArea] || sourceArea;
  const menuRef = menuTitle || menuId;
  const itemRef = itemLabel || itemId;

  const sourceParts = [
    areaLabel,
    menuRef ? `Menu: ${menuRef}` : '',
    itemRef ? `Opcao: ${itemRef}` : '',
    command ? `Comando: ${command}` : ''
  ].filter(Boolean);

  const sourceText = sourceParts.join(' | ');
  const reason = `Origem do pedido: ${sourceText}`;
  const summary = extra
    ? `${extra}. ${reason}`
    : `Cliente solicitou atendimento humano. ${reason}`;
  const tags = [
    'handoff:human_request',
    `source_area:${sourceArea}`,
    menuId ? `source_menu:${menuId}` : '',
    itemId ? `source_item:${itemId}` : '',
    command ? `source_command:${command}` : ''
  ].filter(Boolean);

  return { reason, summary, tags };
}

// Função para enviar confirmação de telefone com botões
async function sendPhoneConfirmation(remoteJid: string, clientPhone: string): Promise<void> {
  console.log(`\n PHONE CONFIRM: Enviando confirmação de telefone para ${clientPhone}`);
  
  const message = [
    '📱 Vamos confirmar seu WhatsApp de contato.',
    '',
    `${clientPhone}`,
    '',
    '1. ✅ Usar este numero',
    '2. ✏️ Informar outro numero',
    '3. ↩️ Cancelar cadastro',
    '',
    'Digite 1, 2 ou 3.'
  ].join('\n');
  
  try {
    await sock!.sendMessage(remoteJid, { text: message });
    console.log(` PHONE CONFIRM: Menu textual enviado`);
  } catch (error) {
    console.error(` PHONE CONFIRM: Erro:`, error);
  }
}

// Função para enviar lista de nichos
async function sendNicheList(remoteJid: string): Promise<void> {
  console.log(`\n️  NICHE LIST: Enviando lista de nichos`);
  
  const niches = REGISTRATION_NICHES;
  
  try {
    let nicheText = '🏪 Qual e o nicho principal do seu negocio?\n\n';
    niches.forEach((niche, index) => {
      nicheText += `${index + 1}. ${niche.trim()}\n`;
    });
    nicheText += `13. Outro nicho\n\nDigite o numero da opcao ou escreva seu proprio nicho.`;
    await sock!.sendMessage(remoteJid, { text: nicheText });
    console.log(` NICHE LIST: Lista textual enviada`);
  } catch (error) {
    console.error(` NICHE LIST: Erro:`, error);
  }
}

// Mapa de nichos para facilitar a busca
const nichesMap: { [key: string]: string } = {
  'niche_0': ' Pizzaria',
  'niche_1': ' Açaíteria',
  'niche_2': ' Lanchonete',
  'niche_3': ' Restaurante',
  'niche_4': ' Confeitaria',
  'niche_5': ' Saudável',
  'niche_6': ' Sushi Bar',
  'niche_7': ' Mexicano',
  'niche_8': ' Italiana',
  'niche_9': ' Café',
  'niche_10': ' Sucos/Bebidas',
  'niche_11': ' Marmitaria'
};

// Função para enviar lista de serviços
async function sendServicesList(remoteJid: string): Promise<void> {
  console.log(`\n SERVICES LIST: Enviando lista de serviços`);
  
  const services = REGISTRATION_SERVICES;
  
  try {
    let servicesText = '🍽️ Como sua loja atende hoje?\n\n';
    services.forEach((service, index) => {
      servicesText += `${index + 1}. ${service.name.trim()}\n`;
    });
    servicesText += `\nDigite o numero da opcao.`;
    await sock!.sendMessage(remoteJid, { text: servicesText });
    console.log(` SERVICES LIST: Lista textual enviada`);
  } catch (error) {
    console.error(` SERVICES LIST: Erro:`, error);
  }
}

// Mapa de serviços para facilitar a busca
const servicesMap: { [key: string]: string } = {
  'service_0': 'retirada',
  'service_1': 'delivery',
  'service_2': 'local',
  'service_3': 'retirada,delivery',
  'service_4': 'retirada,local',
  'service_5': 'delivery,local',
  'service_6': 'retirada,delivery,local'
};

// Função para enviar mensagem de upgrade quando cliente já tem cadastro aprovado
async function sendUpgradeMessage(remoteJid: string, plan: string): Promise<void> {
  console.log(`\n️ UPGRADE: Enviando mensagem de upgrade para ${remoteJid} - Plano: ${plan}`);
  
  try {
    const message = [
      `🚀 Voce ja possui um cadastro ativo no plano *${plan}*.`,
      '',
      '1. 💼 Quero fazer upgrade',
      '2. 📞 Falar com atendente',
      '3. ↩️ Voltar ao menu',
      '',
      'Digite 1, 2 ou 3.'
    ].join('\n');

    await sock!.sendMessage(remoteJid, { text: message });
    userMonitor?.updateUserMenu(remoteJid, 'upgrade_context');
    console.log(` UPGRADE: Menu textual enviado`);
  } catch (error) {
    console.error(` UPGRADE: Erro:`, error);
  }
}

// Função para enviar confirmação final com botões
async function sendRegistrationConfirmation(remoteJid: string, summary: string): Promise<void> {
  console.log(`\n CONFIRMATION: Enviando resumo com botões de confirmação`);
  
  try {
    const message = [
      '📝 Confira os dados do seu cadastro:',
      '',
      summary,
      '',
      '1. ✅ Confirmar cadastro',
      '2. ↩️ Cancelar',
      '',
      'Digite 1 ou 2.'
    ].join('\n');
    await sock!.sendMessage(remoteJid, { text: message });
    console.log(` CONFIRMATION: Resumo textual enviado`);
  } catch (error) {
    console.error(` CONFIRMATION: Erro:`, error);
  }
}

// Função para buscar endereço por CEP
async function fetchAddressByCEP(cep: string): Promise<{ street?: string; neighborhood?: string; city?: string; state?: string; error?: boolean }> {
  try {
    console.log(`\n CEP LOOKUP: Buscando endereço para CEP ${cep}`);
    
    // Limpar o CEP de caracteres especiais
    const cleanCEP = cep.replace(/\D/g, '');
    
    const response = await fetch(`https://viacep.com.br/ws/${cleanCEP}/json/`);
    const data = await response.json() as any;
    
    if (data.erro) {
      console.log(` CEP LOOKUP: CEP não encontrado`);
      return { error: true };
    }
    
    console.log(` CEP LOOKUP: Endereço encontrado - ${data.logradouro}, ${data.bairro}, ${data.localidade}, ${data.uf}`);
    
    return {
      street: data.logradouro || '',
      neighborhood: data.bairro || '',
      city: data.localidade || '',
      state: data.uf || ''
    };
  } catch (error) {
    console.error(` CEP LOOKUP: Erro ao buscar CEP:`, error);
    return { error: true };
  }
}

// Função para enviar confirmação de CEP com endereço
async function sendCEPConfirmation(remoteJid: string, cep: string, address: { street?: string; neighborhood?: string; city?: string; state?: string }): Promise<void> {
  console.log(`\n CEP CONFIRM: Enviando confirmação de CEP`);
  
  const message = [
    `📍 Encontramos este endereco para o CEP ${cep}:`,
    '',
    `${address.street || 'Rua nao encontrada'}`,
    `${address.neighborhood || 'Bairro nao encontrado'}`,
    `${address.city || 'Cidade nao encontrada'}, ${address.state || 'UF'}`,
    '',
    '1. ✅ Endereco correto',
    '2. ✏️ Corrigir endereco',
    '',
    'Digite 1 ou 2.'
  ].join('\n');
  
  try {
    await sock!.sendMessage(remoteJid, { text: message });
    console.log(` CEP CONFIRM: Menu textual enviado`);
  } catch (error) {
    console.error(` CEP CONFIRM: Erro:`, error);
  }
}

// Função para gerar a pergunta baseada na etapa do cadastro
function getRegistrationQuestion(lastQuestion: string, userName?: string): string {
  const name = userName ? `, ${userName.split(' ')[0]}` : '';
  
  const questions: { [key: string]: string } = {
    name: '👋 Para comecar, me informe seu nome completo.',
    
    phone_confirmation: '📱 Podemos usar este numero de WhatsApp como contato principal?\n\nDigite SIM para confirmar ou envie outro numero.',
    
    email: '📧 Qual e o melhor email para contato?\nExemplo: nome@empresa.com',
    
    store_name: `🍕 Perfeito${name}!\n\nQual e o nome da sua loja?`,
    
    niche: '🏪 Qual e o nicho principal do seu negocio?',
    
    address_cep: `📍 Agora vamos ao endereco.\n\nQual e o CEP da loja?\nFormato: XXXXX-XXX ou XXXXXXXX`,
    
    address_street: '🛣️ Qual e o nome da rua ou avenida?',
    
    address_number: '🔢 Qual e o numero do estabelecimento?',
    
    address_neighborhood: '📌 Qual e o bairro?',
    
    service_types: '🍽️ Como sua loja atende hoje?\n\nEscolha uma opcao da lista enviada.',
    
    consultation_time: '🕒 Qual e o melhor horario para nossa equipe falar com voce?\nExemplo: Seg a Sex, 14:00 as 18:00'
  };

  return questions[lastQuestion] || 'Ocorreu um erro ao continuar seu cadastro. Tente novamente.';
}

// Função para processar mensagem com debounce (evita processar múltiplas mensagens offline de uma vez)
async function handleMessageWithDebounce(msg: proto.IWebMessageInfo) {
  const remoteJid = msg.key.remoteJid || '';
  
  // Cancelar processamento anterior se existir (vai processar apenas a última mensagem)
  if (messageDebounce.has(remoteJid)) {
    clearTimeout(messageDebounce.get(remoteJid)!);
    console.log(`⏭️  Ignorando mensagem anterior de ${remoteJid} (processando apenas a última)`);
  }
  
  // Agendar processamento da mensagem atual
  const timeout = setTimeout(async () => {
    messageDebounce.delete(remoteJid);
    console.log(` Processando última mensagem de ${remoteJid}`);
    await handleMessage(msg);
  }, DEBOUNCE_DELAY);
  
  messageDebounce.set(remoteJid, timeout);
}

// Função para enviar menu com botões estruturados
async function sendMenu(
  remoteJid: string,
  menuId: string = 'main',
  options?: { fromMenuId?: string; resetHistory?: boolean }
): Promise<void> {
  console.log(`\n SENDMENU: Iniciando envio do menu "${menuId}"`);
  
  try {
    if (options?.resetHistory || menuId === 'main') {
      resetMenuHistory(remoteJid);
    } else if (options?.fromMenuId && options.fromMenuId !== menuId) {
      pushMenuHistory(remoteJid, options.fromMenuId);
    }

    const menu = buildRenderableMenu(remoteJid, menuId);

    if (!menu) {
      console.error(` SENDMENU: Menu não encontrado: "${menuId}"`);
      return;
    }
    
    console.log(` SENDMENU: Menu encontrado: "${menu.title}"`);

    const menuText = [
      menu.message,
      '',
      buildNumberedOptions(menu.items as any[]),
      '',
      'Digite o número da opção desejada.'
    ].join('\n');

    await sock!.sendMessage(remoteJid, { text: menuText });
    userMonitor?.updateUserMenu(remoteJid, menuId);
    console.log(` SENDMENU: Menu textual enviado (${menu.items.length} opções)`);
  } catch (error) {
    console.error(` SENDMENU: ERRO ao enviar menu:`, error);
  }
}

// Função para processar ação do menu
async function handleMenuAction(remoteJid: string, itemId: string, currentMenuId: string = 'main'): Promise<void> {
  console.log(`\n HANDLEACTION: menuId="${currentMenuId}", itemId="${itemId}"`);
  
  try {
    if (itemId === '__menu_back') {
      const previousMenuId = popPreviousMenu(remoteJid) || 'main';
      console.log(` HANDLEACTION: Voltando para menu anterior "${previousMenuId}"`);
      await sendMenu(remoteJid, previousMenuId);
      return;
    }

    if (itemId === '__menu_home') {
      console.log(' HANDLEACTION: Voltando para menu principal');
      await sendMenu(remoteJid, 'main', { resetHistory: true });
      return;
    }

    // Sempre priorizar menus dinamicos do arquivo (config/menus.json)
    const freshMenuManager = new MenuManager();
    let menu: any = freshMenuManager.getMenu(currentMenuId);

    // Se nao encontrar no dinamico, usar o sistema estatico como fallback
    if (!menu) {
      menu = MenuSystem.getMenu(currentMenuId);
    }

    if (!menu) {
      console.error(` HANDLEACTION: Menu não encontrado: "${currentMenuId}"`);
      return;
    }

    const item: any = menu.items.find((i: any) => i.id === itemId);
    if (!item) {
      console.error(` HANDLEACTION: Item "${itemId}" não encontrado no menu "${currentMenuId}"`);
      return;
    }

    console.log(` HANDLEACTION: Item encontrado. Ação: "${item.action}"`);

    userMonitor?.updateUserMenu(remoteJid, currentMenuId);

    if (item.action === 'submenu' && item.submenuId) {
      console.log(` HANDLEACTION: Navegando para submenu "${item.submenuId}"`);
      await sendMenu(remoteJid, item.submenuId, { fromMenuId: currentMenuId });
    } else if (item.action === 'message' && item.message) {
      const content = MenuSystem.getContentMessage(item.message);
      await sock!.sendMessage(remoteJid, { text: content || item.message });
      await wait(500);
      await sock!.sendMessage(remoteJid, { text: buildNavigationHint(remoteJid, currentMenuId) });
    } else if (item.action === 'registration') {
       const plan = item.registrationPlan || 'basic';
       
       console.log(` HANDLEACTION: Item de registro encontrado. Plano: "${plan}"`);
       
       // Verificar se cliente já tem um cadastro aprovado neste plano
       const existingApprovedRegistration = registrationHandler.hasApprovedRegistrationForPlan(remoteJid, plan);
       
       if (existingApprovedRegistration) {
         // Cliente já tem um cadastro aprovado neste plano
         console.log(`HANDLEACTION: Cliente ja tem cadastro aprovado no plano "${plan}". Mostrando opcoes de upgrade.`);
         await sendUpgradeMessage(remoteJid, plan);
       } else {
         // Cliente não tem cadastro aprovado, ir para o submenu de cadastro
         console.log(` HANDLEACTION: Cliente não tem cadastro aprovado. Navegando para submenu: "${item.submenuId}"`);
         
         // Criar um registro de cadastro no RegistrationSystem quando entra no submenu
         const reg = RegistrationSystem.createRegistration(remoteJid, plan as any);
         console.log(` HANDLEACTION: Registro de cadastro criado para plano "${plan}"`);
         
         // Enviar o submenu de cadastro
         const firstQuestion = getRegistrationQuestion(reg.lastQuestion || 'name', reg.name);
         await sock!.sendMessage(remoteJid, { text: firstQuestion });
       }
    } else if (item.action === 'attendant') {
      console.log(`HANDLEACTION: Encaminhando cliente para atendimento humano`);
      const context = buildAttendantRequestContext({
        sourceArea: 'menu',
        menuId: currentMenuId,
        menuTitle: menu.title,
        itemId: item.id,
        itemLabel: item.label
      });
      const result = await startHumanAttendance(remoteJid, 'Usuario', context, {
        connected: tpl('humanConnectedDefault', '🤝 Voce foi encaminhado para um atendente. Em breve nossa equipe respondera sua mensagem.'),
        alreadyActive: tpl('humanConnectedDefault', '🤝 Voce ja esta em atendimento humano. Envie sua mensagem que a equipe vai responder por aqui.')
      });
      if (result.status === 'queue') {
        const queueDetails = attendanceManager?.getQueuePositionDetailed(remoteJid);
        console.log(`[FILA] Cliente ${remoteJid} adicionado a fila de atendimento (posicao: ${queueDetails?.position || 0})`);
      } else {
        console.log('HANDLEACTION: Sessao de atendimento criada');
      }
    }
    } catch (error) {
    console.error(` HANDLEACTION: Erro:`, error);
    try {
      await sock!.sendMessage(remoteJid, { text: tpl('genericRequestErrorShort', 'Houve um erro ao processar sua solicitacao. Tente novamente.') });
    } catch (e) {
      console.error('Erro ao enviar mensagem de erro:', e);
    }
    }
    }

// Função principal de tratamento de mensagens
async function handleMessage(msg: proto.IWebMessageInfo) {
  const message = msg.message;
  if (!message) return;

  // Extrair o texto da mensagem
  let textMessage = '';
  
  if (message.conversation) {
    textMessage = message.conversation;
  } else if (message.extendedTextMessage?.text) {
    textMessage = message.extendedTextMessage.text;
  } else if (message.imageMessage?.caption) {
    textMessage = message.imageMessage.caption;
  } else if (message.videoMessage?.caption) {
    textMessage = message.videoMessage.caption;
  } else if (message.buttonsResponseMessage?.selectedButtonId) {
    // Mensagem de resposta a botões de seção
    const originalButtonId = message.buttonsResponseMessage.selectedButtonId;
    textMessage = originalButtonId;
    console.log(` Botão clicado: ${originalButtonId}`);
  } else if (message.listResponseMessage?.singleSelectReply?.selectedRowId) {
    // Mensagem de resposta a lista (sections)
    const originalRowId = message.listResponseMessage.singleSelectReply.selectedRowId;
    textMessage = originalRowId;
    console.log(` Lista selecionada: ${originalRowId}`);
  }

  const remoteJid = msg.key.remoteJid || '';
  const contact = msg.pushName || 'Usuário';

  // ============ VERIFICAR SE O BOT ESTÁ ATIVO ============
  // Permitir comandos de controle do bot mesmo se desativado
  const isBotControlCommand = textMessage.toLowerCase().includes('!stopbot') || textMessage.toLowerCase().includes('!startbot');
  
  if (!botStatus.isEnabled() && !isBotControlCommand) {
    console.log(` [BOT DESATIVADO] Mensagem ignorada: ${remoteJid}`);
    // Não responder nada quando o bot está desativado
    return;
  }

  // ============ VERIFICAR SE O USUÁRIO ESTÁ BLOQUEADO (PRIORIDADE MÁXIMA) ============
  const isBlocked = adminServer.isUserBlocked(remoteJid);
  if (isBlocked) {
    console.log(` [BLOQUEIO] Mensagem ignorada - Usuário bloqueado: ${remoteJid}`);
    console.log(` [BLOQUEIO] Mensagem: "${textMessage.substring(0, 50)}..."`);
    return;
  }

  // Atualizar usuário no painel administrativo
  adminServer.addOrUpdateUser(remoteJid, contact, textMessage);

  // Registrar usuário no monitor (rastreamento em tempo real)
  if (userMonitor) {
    const existingTrackedUser = userMonitor.getUser(remoteJid);
    userMonitor.registerUser(remoteJid, contact, existingTrackedUser?.currentMenu || 'main');
    userMonitor.addMessageReceived(remoteJid);
  }

  // Remover espaços e converter para minúsculas para comparação
  let command = textMessage.trim().toLowerCase();

  if (!sock) {
    console.log('Socket não está conectado');
    return;
  }

  try {
     // Ignorar mensagens enviadas pelo próprio bot
     if (msg.key.fromMe) return;

     if (/^\d+$/.test(command)) {
       const currentMenuId = userMonitor?.getUser(remoteJid)?.currentMenu || 'main';
       if (currentMenuId === 'upgrade_context') {
         if (command === '1') command = 'upgrade_yes';
         if (command === '2') command = 'talk_attendant';
         if (command === '3') command = 'back_menu';
       }
       const currentMenu = buildRenderableMenu(remoteJid, currentMenuId);
       const numericChoice = currentMenu ? getNumericChoice(command, currentMenu.items.length) : null;
       if (numericChoice && currentMenu) {
         const selectedItem = currentMenu.items[numericChoice - 1];
         if (selectedItem?.id) {
           console.log(` MENU TEXT: "${command}" mapeado para item "${selectedItem.id}" no menu "${currentMenuId}"`);
           command = selectedItem.id;
         }
       }
     }

     // ============ COMANDOS DE CONTROLE DO BOT (APENAS ADMIN) ============
     if (isAdminControlJid(remoteJid)) {
       if (command === '!stopbot') {
         const wasEnabled = botStatus.isEnabled();
         if (botStatus.disableBot(contact)) {
           await sock.sendMessage(remoteJid, {
              text: tpl('botDisabledByAdmin', 'BOT DESATIVADO COM SUCESSO!\n\nO bot nao respondera a ninguem ate ser reativado.\n\nUse !startbot para ativar novamente.')
           });
           console.log(` BOT DESATIVADO por ${contact}`);
         } else {
           await sock.sendMessage(remoteJid, {
              text: tpl('botAlreadyDisabled', 'O bot ja esta desativado.')
           });
         }
         return;
       }
       
       if (command === '!startbot') {
         if (botStatus.enableBot(contact)) {
           await sock.sendMessage(remoteJid, {
              text: tpl('botEnabledByAdmin', 'BOT ATIVADO COM SUCESSO!\n\nO bot esta operacional novamente e respondendo normalmente.')
           });
           console.log(` BOT ATIVADO por ${contact}`);
         } else {
           await sock.sendMessage(remoteJid, {
              text: tpl('botAlreadyEnabled', 'O bot ja esta ativado.')
           });
         }
         return;
       }
     }

     const trackedConversationState = userMonitor?.getUser(remoteJid)?.currentMenu || 'main';
     const activeSession = attendanceManager?.getActiveSession(remoteJid);
     const queueDetails = attendanceManager?.getQueuePositionDetailed(remoteJid);

     // ============ CONTROLE INTELIGENTE DE FILA ============
     if (queueDetails) {
       userMonitor?.updateUserMenu(remoteJid, 'attendance_waiting');
       console.log(`[ATENDIMENTO] Cliente ${remoteJid} enviou mensagem enquanto aguardava na fila`);
       if (command === 'menu' || command === 'voltar') {
         console.log(`[ATENDIMENTO] Cliente ${remoteJid} saiu da fila manualmente`);
         attendanceManager.removeFromQueue(remoteJid, 'manual_remove');
         await sock.sendMessage(remoteJid, {
            text: tpl('queueExitToMenu', 'Voce saiu da fila de atendimento e voltou ao menu principal.')
         });
         await wait(250);
         await sendMenu(remoteJid, 'main');
         return;
       }

       const slaSnapshot = attendanceManager?.getSlaSnapshot?.();
       const avgQueueSeconds = Number(slaSnapshot?.response?.avgQueueWaitSeconds) || (queueDetails.estimatedWaitMinutes * 60);
       const avgQueueMinutes = Math.max(1, Math.round(avgQueueSeconds / 60));
       const queueStatusText = typeof attendanceManager?.getQueueStatusMessage === 'function'
         ? attendanceManager.getQueueStatusMessage(queueDetails.position, queueDetails.estimatedWaitMinutes, avgQueueMinutes)
         : (
           'Voce continua na fila de atendimento.\n'
           + `Posicao atual: ${queueDetails.position}.\n`
           + `Tempo estimado atual: ${queueDetails.estimatedWaitMinutes} minuto(s).\n`
           + `Tempo medio observado: ${avgQueueMinutes} minuto(s).\n\n`
           + 'Para sair da fila e voltar ao menu principal, digite: menu'
         );

       await sock.sendMessage(remoteJid, {
         text: queueStatusText
       });
       return;
     }

     if (!queueDetails && trackedConversationState === 'attendance_waiting') {
       if (command === 'menu' || command === 'voltar') {
         await sendMenu(remoteJid, 'main');
         return;
       }

       await sock.sendMessage(remoteJid, {
         text: tpl(
           'queuePendingFallback',
           'Seu pedido de atendimento ja foi registrado. Assim que um especialista estiver disponivel, ele vai falar com voce aqui.\n\nSe quiser voltar ao menu principal, digite: menu'
         )
       });
       return;
     }

     // ============ SESSAO ATIVA DE ATENDIMENTO ============
     if (activeSession) {
       userMonitor?.updateUserMenu(remoteJid, 'attendance_active');
       console.log(`[ATENDIMENTO] Cliente ${remoteJid} esta em sessao ativa (${activeSession.sessionId})`);

       const exitCommands = ['menu', 'finalizar atendimento', 'sair', 'voltar'];
       if (exitCommands.includes(command)) {
         console.log(`[ATENDIMENTO] Cliente ${remoteJid} encerrou a sessao humana`);
         await attendanceManager?.endSession(activeSession.sessionId, true);
         await sock.sendMessage(remoteJid, {
           text: tpl('attendanceEndedByClient', 'Atendimento finalizado. Voltando ao menu principal...')
         });
         await wait(500);
         await sendMenu(remoteJid, 'main');
         return;
       }

       attendanceManager?.addMessageToSession(activeSession.sessionId, 'client', textMessage);
       console.log(`[ATENDIMENTO] Mensagem do cliente ${remoteJid} registrada na sessao humana`);
       return;
     }

     if (!activeSession && trackedConversationState === 'attendance_active') {
       if (command === 'menu' || command === 'voltar') {
         await sendMenu(remoteJid, 'main');
         return;
       }

       await sock.sendMessage(remoteJid, {
         text: tpl(
           'attendancePendingFallback',
           'Seu atendimento humano continua em andamento. Aguarde a resposta da equipe.\n\nSe quiser voltar ao menu principal, digite: menu'
         )
       });
       return;
     }

     // ============ TRATAMENTO DE BOTES DE CONFIRMAO FINAL (PRIORIDADE ALTA) ============
     const registration = RegistrationSystem.getRegistration(remoteJid);

     if (registration && registration.lastQuestion === 'confirmation') {
      if (command === 'confirm_registration' || textMessage.trim() === '1') {
         // Confirmar cadastro
         console.log(' REGISTRO: Processando confirmação de cadastro');
         try {
           const finalizedReg = RegistrationSystem.finalizeRegistration(remoteJid);
           if (finalizedReg) {
             console.log(' REGISTRO: Cadastro finalizado com sucesso, salvando dados...');
             
             //  SALVAR NO BANCO DE DADOS (CORREO CRÍTICA)
             const resolvedClientName = resolveFinalClientName(finalizedReg, contact);
             const savedRegistration = registrationHandler.createRegistration(
               finalizedReg.clientJid,
               resolvedClientName,
               {
                 clientPhone: finalizedReg.phone || finalizedReg.clientPhone || '',
                 clientEmail: finalizedReg.email || '',
                 address: finalizedReg.address ? JSON.stringify(finalizedReg.address) : '',
                 plan: finalizedReg.plan || 'basic',
                 additionalInfo: finalizedReg.storeName ? `Loja: ${finalizedReg.storeName}${finalizedReg.niche ? `, Nicho: ${finalizedReg.niche}` : ''}` : ''
               }
             );
             console.log(' REGISTRO: Dados salvos com ID:', savedRegistration.id);
             await sendOperationalNotification(
               'registration',
               buildRegistrationNotificationMessage(savedRegistration, finalizedReg, contact)
             );
             
             await sock.sendMessage(remoteJid, {
               text: '✅ Cadastro realizado com sucesso!\n\nSeu pedido de entrada no Cardapio JK foi registrado.\n\n📧 Voce recebera no email os proximos passos para ativar seu cardapio digital.\n\n🤝 Em breve nossa equipe entrara em contato para finalizar a configuracao.'
             });
             await wait(1000);
             await sendMenu(remoteJid, 'main');
           }
         } catch (error) {
           console.error(' REGISTRO: Erro ao finalizar cadastro:', error);
           await sock.sendMessage(remoteJid, {
             text: 'Nao foi possivel concluir seu cadastro agora.\n\nTente novamente em instantes ou digite *menu* para falar com um atendente.'
           });
         }
         return;
       } else if (command === 'cancel_registration_final' || textMessage.trim() === '2') {
         // Cancelar cadastro
         console.log('️ REGISTRO: Cancelando cadastro');
         RegistrationSystem.cancelRegistration(remoteJid);
         await sock.sendMessage(remoteJid, {
            text: 'Cadastro cancelado.\n\n↩️ Voltando ao menu principal...'
         });
         await wait(500);
         await sendMenu(remoteJid, 'main');
         return;
       } else if (command === 'confirmar') {
         // Tratamento legado - digitar "confirmar"
         console.log(' REGISTRO: Processando confirmação legada');
         try {
           const finalizedReg = RegistrationSystem.finalizeRegistration(remoteJid);
           if (finalizedReg) {
             console.log(' REGISTRO: Cadastro finalizado com sucesso, salvando dados...');
             
             //  SALVAR NO BANCO DE DADOS (CORREO CRÍTICA)
             const resolvedClientName = resolveFinalClientName(finalizedReg, contact);
             const savedRegistration = registrationHandler.createRegistration(
               finalizedReg.clientJid,
               resolvedClientName,
               {
                 clientPhone: finalizedReg.phone || finalizedReg.clientPhone || '',
                 clientEmail: finalizedReg.email || '',
                 address: finalizedReg.address ? JSON.stringify(finalizedReg.address) : '',
                 plan: finalizedReg.plan || 'basic',
                 additionalInfo: finalizedReg.storeName ? `Loja: ${finalizedReg.storeName}${finalizedReg.niche ? `, Nicho: ${finalizedReg.niche}` : ''}` : ''
               }
             );
             console.log(' REGISTRO: Dados salvos com ID:', savedRegistration.id);
             await sendOperationalNotification(
               'registration',
               buildRegistrationNotificationMessage(savedRegistration, finalizedReg, contact)
             );
             
             await sock.sendMessage(remoteJid, {
               text: '✅ Cadastro realizado com sucesso!\n\nSeu pedido de entrada no Cardapio JK foi registrado.\n\n📧 Voce recebera no email os proximos passos para ativar seu cardapio digital.\n\n🤝 Em breve nossa equipe entrara em contato para finalizar a configuracao.'
             });
             await wait(1000);
             await sendMenu(remoteJid, 'main');
           }
         } catch (error) {
           console.error(' REGISTRO: Erro ao finalizar cadastro:', error);
           await sock.sendMessage(remoteJid, {
             text: 'Nao foi possivel concluir seu cadastro agora.\n\nTente novamente em instantes ou digite *menu* para falar com um atendente.'
           });
         }
         return;
       } else {
         // Se estiver na tela de confirmação mas digitar algo diferente, re-enviar os botões
          console.log('REGISTRO: Comando nao reconhecido na confirmacao:', command);
         const summary = RegistrationSystem.generateSummary(remoteJid);
         await sendRegistrationConfirmation(remoteJid, summary);
         return;
       }
     }

     // ============ TRATAMENTO DE BOTES DE CONFIRMAO DE TELEFONE ============
    if (registration && registration.lastQuestion === 'phone_confirmation') {
      if (command === 'confirm_phone' || textMessage.trim() === '1') {
        // Usar o número do cliente
        const result = RegistrationSystem.updateRegistration(remoteJid, 'SIM');
        if (result.valid && result.nextQuestion) {
          const nextQuestion = getRegistrationQuestion(result.nextQuestion, registration.name);
          await sock.sendMessage(remoteJid, { text: nextQuestion });
        }
        return;
      } else if (command === 'different_phone' || textMessage.trim() === '2') {
        // Pedir outro número
        await sock.sendMessage(remoteJid, {
          text: '📱 Envie o numero de WhatsApp que deseja cadastrar.\nFormato: 11999999999 ou +5511999999999'
        });
        // Mudar estado para aguardar outro número
        registration.lastQuestion = 'phone_alternative';
        return;
      } else if (command === 'cancel_registration' || textMessage.trim() === '3') {
        // Cancelar cadastro
        RegistrationSystem.cancelRegistration(remoteJid);
        await sock.sendMessage(remoteJid, {
          text: 'Cadastro cancelado.\n\n↩️ Voltando ao menu principal...'
        });
        await wait(500);
        await sendMenu(remoteJid, 'main');
        return;
      } else if (!command.startsWith('confirm_') && !command.startsWith('different_') && !command.startsWith('cancel_')) {
        // Se for texto normal, tentar processar como um número alternativo
        const result = RegistrationSystem.updateRegistration(remoteJid, textMessage);
        if (result.valid && result.nextQuestion) {
          const nextQuestion = getRegistrationQuestion(result.nextQuestion, registration.name);
          await sock.sendMessage(remoteJid, { text: nextQuestion });
        } else if (!result.valid) {
          await sock.sendMessage(remoteJid, {
            text: `${result.message}\n\n📱 Envie o numero de WhatsApp que deseja cadastrar.\nFormato: 11999999999 ou +5511999999999`
          });
        }
        return;
      }
    }

    // ============ TRATAMENTO DE NMERO ALTERNATIVO DE TELEFONE ============
    if (registration && registration.lastQuestion === 'phone_alternative') {
      const result = RegistrationSystem.updateRegistration(remoteJid, textMessage);
      if (result.valid && result.nextQuestion) {
        const nextQuestion = getRegistrationQuestion(result.nextQuestion, registration.name);
        await sock.sendMessage(remoteJid, { text: nextQuestion });
      } else if (!result.valid) {
        await sock.sendMessage(remoteJid, {
          text: `${result.message}\n\n📱 Envie o numero de WhatsApp que deseja cadastrar.\nFormato: 11999999999 ou +5511999999999`
        });
      }
      return;
    }

    // ============ TRATAMENTO DE SELEO DE NICHO ============
    if (registration && registration.lastQuestion === 'niche') {
      let nicheValue = textMessage;
      
      // Se for um ID de nicho selecionado na lista
      const numericNicheChoice = getNumericChoice(textMessage, 13);
      if (numericNicheChoice) {
        if (numericNicheChoice === 13) {
          await sock.sendMessage(remoteJid, {
            text: '✏️ Digite o nicho do seu negocio.'
          });
          registration.lastQuestion = 'niche_custom';
          return;
        }
        nicheValue = REGISTRATION_NICHES[numericNicheChoice - 1];
      } else if (command.startsWith('niche_')) {
        if (command === 'niche_custom') {
          // Usuário quer digitar um nicho customizado
          await sock.sendMessage(remoteJid, {
            text: '✏️ Digite o nicho do seu negocio.'
          });
          registration.lastQuestion = 'niche_custom';
          return;
        } else if (nichesMap[command]) {
          // Nicho predefinido foi selecionado
          nicheValue = nichesMap[command];
        }
      }
      
      // Processar o nicho
      const result = RegistrationSystem.updateRegistration(remoteJid, nicheValue);
      if (result.valid && result.nextQuestion) {
        const nextQuestion = getRegistrationQuestion(result.nextQuestion, registration.name);
        await sock.sendMessage(remoteJid, { text: nextQuestion });
      } else if (!result.valid) {
        await sendNicheList(remoteJid);
      }
      return;
    }

    // ============ TRATAMENTO DE NICHO CUSTOMIZADO ============
     if (registration && registration.lastQuestion === 'niche_custom') {
       const result = RegistrationSystem.updateRegistration(remoteJid, textMessage);
       if (result.valid && result.nextQuestion) {
         const nextQuestion = getRegistrationQuestion(result.nextQuestion, registration.name);
         await sock.sendMessage(remoteJid, { text: nextQuestion });
       } else if (!result.valid) {
         await sock.sendMessage(remoteJid, {
           text: `${result.message}\n\n✏️ Digite o nicho do seu negocio.`
         });
       }
       return;
     }

     // ============ TRATAMENTO DE SELEO DE SERVIOS ============
     if (registration && registration.lastQuestion === 'service_types') {
       let serviceValue = textMessage;
       
       // Se for um ID de serviço selecionado na lista
       const numericServiceChoice = getNumericChoice(textMessage, REGISTRATION_SERVICES.length);
       if (numericServiceChoice) {
         serviceValue = REGISTRATION_SERVICES[numericServiceChoice - 1].value;
       } else if (command.startsWith('service_')) {
         if (servicesMap[command]) {
           // Serviço predefinido foi selecionado
           serviceValue = servicesMap[command];
         }
       }
       
       // Processar os serviços
       const result = RegistrationSystem.updateRegistration(remoteJid, serviceValue);
       if (result.valid && result.nextQuestion) {
         if (result.nextQuestion === 'confirmation') {
           // Mostrar resumo com botões de confirmação
           const summary = RegistrationSystem.generateSummary(remoteJid);
           registration.lastQuestion = 'confirmation';
           await sendRegistrationConfirmation(remoteJid, summary);
         } else {
           const nextQuestion = getRegistrationQuestion(result.nextQuestion, registration.name);
           await sock.sendMessage(remoteJid, { text: nextQuestion });
         }
       } else if (!result.valid) {
         await sendServicesList(remoteJid);
       }
       return;
     }

     // ============ TRATAMENTO DE CEP COM BUSCA AUTOMÁTICA ============
     if (registration && registration.lastQuestion === 'address_cep') {
       // Validar formato do CEP
       if (!/^\d{5}-?\d{3}$/.test(textMessage.trim())) {
         await sock.sendMessage(remoteJid, {
           text: '📍 CEP invalido.\nUse o formato XXXXX-XXX ou XXXXXXXX.\n\nDigite o CEP novamente:'
         });
         return;
       }
       
       // Buscar endereço pelo CEP
       const addressData = await fetchAddressByCEP(textMessage);
       
       if (addressData.error || !addressData.street) {
         await sock.sendMessage(remoteJid, {
            text: '📍 Nao encontramos esse CEP.\n\nDigite o CEP novamente:'
         });
         return;
       }
       
       // Salvar o CEP e os dados do endereço buscados
       registration.address = {
         cep: textMessage,
         street: addressData.street,
         neighborhood: addressData.neighborhood,
         city: addressData.city,
         state: addressData.state
       };
       registration.lastQuestion = 'cep_confirmation';
       
       // Enviar confirmação do endereço
       await sendCEPConfirmation(remoteJid, textMessage, addressData);
       return;
     }

     // ============ TRATAMENTO DE CONFIRMAO DE CEP ============
     if (registration && registration.lastQuestion === 'cep_confirmation') {
       if (command === 'confirm_cep' || textMessage.trim() === '1') {
         // Endereço correto, pular para número
         registration.cepConfirmed = true; // Marcar que CEP foi confirmado
         registration.lastQuestion = 'address_number';
         await sock.sendMessage(remoteJid, {
            text: '🔢 Qual e o numero do estabelecimento?'
         });
         return;
       } else if (command === 'different_address' || textMessage.trim() === '2') {
         // Endereço incorreto, perguntar rua
         registration.cepConfirmed = false; // CEP não confirmado, precisará pedir bairro
         registration.lastQuestion = 'address_street';
         await sock.sendMessage(remoteJid, {
            text: '🛣️ Qual e o nome da rua ou avenida?'
         });
         return;
       }
     }

     // ============ TRATAMENTO DE ENDEREO MANUAL (RUA) ============
     if (registration && registration.lastQuestion === 'address_street') {
       if (textMessage.trim().length < 3) {
         await sock.sendMessage(remoteJid, {
            text: 'A rua precisa ter pelo menos 3 caracteres.\n\n🛣️ Digite o nome da rua ou avenida.'
         });
         return;
       }
       
       if (!registration.address) {
         registration.address = {};
       }
       registration.address.street = textMessage;
       registration.lastQuestion = 'address_number';
       
       await sock.sendMessage(remoteJid, {
          text: '🔢 Qual e o numero do estabelecimento?'
       });
       return;
     }

     // ============ TRATAMENTO DE ENDEREO MANUAL (NMERO) ============
     if (registration && registration.lastQuestion === 'address_number') {
       if (textMessage.trim().length < 1) {
         await sock.sendMessage(remoteJid, {
            text: 'O numero do estabelecimento precisa ser informado.\n\n🔢 Digite o numero do estabelecimento.'
         });
         return;
       }
       
       if (!registration.address) {
         registration.address = {};
       }
       registration.address.number = textMessage;
       
       // Se o CEP foi confirmado, o bairro já está preenchido, vamos direto para serviços
       if (registration.cepConfirmed) {
         registration.lastQuestion = 'service_types';
         await sendServicesList(remoteJid);
       } else {
         // Se o endereço foi digitado manualmente, precisa pedir bairro
         registration.lastQuestion = 'address_neighborhood';
         await sock.sendMessage(remoteJid, {
            text: '📌 Qual e o bairro?'
         });
       }
       return;
     }

     // ============ TRATAMENTO DE ENDEREO MANUAL (BAIRRO) ============
     if (registration && registration.lastQuestion === 'address_neighborhood') {
       if (textMessage.trim().length < 3) {
         await sock.sendMessage(remoteJid, {
            text: 'O bairro precisa ter pelo menos 3 caracteres.\n\n📌 Digite o bairro.'
         });
         return;
       }
       
       if (!registration.address) {
         registration.address = {};
       }
       registration.address.neighborhood = textMessage;
       registration.lastQuestion = 'service_types';
       
       await sendServicesList(remoteJid);
       return;
     }

    // ============ VERIFICAR SE ESTÁ EM PROCESSO DE REGISTRO ============
    if (registration) {
      if (isPlaceholderRegistrationValue(textMessage)) {
        await sock.sendMessage(remoteJid, {
          text: '✍️ Para continuar o cadastro, envie sua resposta em texto.'
        });
        return;
      }

      // Verificar comandos especiais de cancelamento
      if (command === 'cancelar' || command === 'cancel' || command === 'cancel_registration') {
        RegistrationSystem.cancelRegistration(remoteJid);
        await sock.sendMessage(remoteJid, {
          text: 'Cadastro cancelado.\n\n↩️ Voltando ao menu principal...'
        });
        await wait(500);
        await sendMenu(remoteJid, 'main');
        return;
      }

      // Se for para voltar ao menu
      if (command === 'menu' || command === 'voltar') {
        RegistrationSystem.cancelRegistration(remoteJid);
        await sendMenu(remoteJid, 'main');
        return;
      }

      const attendantCommands = new Set([
        'talk_attendant',
        'atendente',
        'falar com atendente',
        'quero falar com atendente',
        'suporte humano',
        'atendimento humano'
      ]);

      if (attendantCommands.has(command)) {
        const context = buildAttendantRequestContext({
          sourceArea: 'cadastro',
          command,
          extra: `Solicitou durante cadastro (etapa: ${registration.lastQuestion || 'desconhecida'})`
        });
        await startHumanAttendance(remoteJid, contact, context, {
          connected: tpl('humanConnectedFromRegistration', '🤝 Voce foi encaminhado para um atendente. Aguarde a resposta da nossa equipe.'),
          alreadyActive: tpl('humanConnectedFromRegistration', '🤝 Voce ja esta em atendimento humano. Aguarde a resposta da nossa equipe.')
        });
        return;
      }

      // Processar resposta do cadastro
      const result = RegistrationSystem.updateRegistration(remoteJid, textMessage);

      if (!result.valid) {
        // Resposta inválida, pedir novamente
        await sock.sendMessage(remoteJid, {
          text: ` ${result.message}\n\n${getRegistrationQuestion(registration.lastQuestion || 'name', registration.name)}`
        });
        return;
      }

      // Resposta válida, passar para próxima etapa
      if (result.nextQuestion === 'confirmation') {
        // Mostrar resumo com botões de confirmação
        const summary = RegistrationSystem.generateSummary(remoteJid);
        registration.lastQuestion = 'confirmation';
        await sendRegistrationConfirmation(remoteJid, summary);
        return;
      } else if (result.nextQuestion === 'phone_confirmation') {
        // Enviar confirmação com botões
        const reg = RegistrationSystem.getRegistration(remoteJid)!;
        await sendPhoneConfirmation(remoteJid, reg.clientPhone || 'Número desconhecido');
        return;
      } else if (result.nextQuestion === 'niche') {
        // Enviar lista de nichos
        await sendNicheList(remoteJid);
        return;
      } else if (result.nextQuestion === 'service_types') {
        // Enviar lista de serviços
        await sendServicesList(remoteJid);
        return;
      } else if (result.nextQuestion) {
        const nextQuestion = getRegistrationQuestion(result.nextQuestion, registration.name);
        await sock.sendMessage(remoteJid, {
          text: nextQuestion
        });
        return;
      }
    }



    // ============ TRATAMENTO DE BOTES DE UPGRADE (CLIENTE COM CADASTRO APROVADO) ============
    if (command === 'upgrade_yes') {
      // Cliente quer fazer upgrade - iniciar atendimento
      console.log(`UPGRADE: Cliente ${remoteJid} deseja fazer upgrade`);
      const context = buildAttendantRequestContext({
        sourceArea: 'upgrade',
        command,
        extra: 'Solicitou falar com atendente'
      });
      const result = await startHumanAttendance(remoteJid, contact, context, {
        connected: '🤝 Conexao iniciada!\n\nUm especialista vai falar com voce em breve para apresentar as melhores opcoes de upgrade.',
        alreadyActive: '🤝 Voce ja esta em atendimento humano. Envie sua mensagem e nossa equipe continuara por aqui.'
      });
      if (result.status === 'queue') {
        const queueDetails = attendanceManager?.getQueuePositionDetailed(remoteJid);
        console.log(`[FILA] Cliente ${remoteJid} adicionado a fila (posicao: ${queueDetails?.position || 0})`);
      } else {
        console.log(' UPGRADE: Sessão de atendimento criada');
      }
      return;
    } else if (command === 'talk_attendant') {
      // Cliente quer falar com atendente
      console.log(`UPGRADE: Cliente ${remoteJid} quer falar com atendente`);
      const context = buildAttendantRequestContext({
        sourceArea: 'upgrade',
        command,
        extra: 'Solicitou falar com atendente'
      });
      const result = await startHumanAttendance(remoteJid, contact, context, {
        connected: tpl('humanConnectedDefault', '🤝 Voce foi encaminhado para um atendente. Em breve nossa equipe respondera sua mensagem.'),
        alreadyActive: tpl('humanConnectedDefault', '🤝 Voce ja esta em atendimento humano. Envie sua mensagem que a equipe vai responder por aqui.')
      });
      if (result.status === 'queue') {
        const queueDetails = attendanceManager?.getQueuePositionDetailed(remoteJid);
        console.log(`[FILA] Cliente ${remoteJid} adicionado a fila (posicao: ${queueDetails?.position || 0})`);
      } else {
        console.log(' UPGRADE: Sessão de atendimento criada');
      }
      return;
    } else if (command === 'back_menu') {
      // Cliente quer voltar ao menu
      console.log(`UPGRADE: Cliente ${remoteJid} voltando ao menu`);
      await sendMenu(remoteJid, 'main');
      return;
    }

    // Log de debug para mensagens recebidas
    console.log(` Mensagem recebida: "${command}"`);

    // ============ SISTEMA DE MENU ESTRUTURADO ============
    const currentTrackedMenuId = userMonitor?.getUser(remoteJid)?.currentMenu || 'main';
    const currentTrackedMenu = buildRenderableMenu(remoteJid, currentTrackedMenuId);
    const currentMenuItem = currentTrackedMenu?.items.find((item: any) => item.id === command);
    if (currentMenuItem) {
      await handleMenuAction(remoteJid, command, currentTrackedMenuId);
      return;
    }

    const locatedMenuItem = findMenuItemLocation(command);
    if (locatedMenuItem) {
      console.log(` MENU ROUTER: comando "${command}" encontrado no menu "${locatedMenuItem.menuId}"`);
      await handleMenuAction(remoteJid, command, locatedMenuItem.menuId);
      return;
    }

      // Se nenhum comando foi processado, enviar menu principal
      console.log(`️  Comando não reconhecido. Enviando menu principal.`);
      await sendMenu(remoteJid, 'main');

  } catch (error) {
    console.error(' Erro ao enviar mensagem:', error);
  }
}

// Função helper para enviar mensagem e rastrear no monitor
async function sendMessageWithTracking(jid: string, content: any): Promise<void> {
  if (!sock) {
    console.error('Socket não disponível para enviar mensagem');
    return;
  }
  
  try {
    await sock.sendMessage(jid, content);
    
    // Registrar mensagem enviada no monitor
    if (userMonitor) {
      userMonitor.addMessageSent(jid);
    }
  } catch (error) {
    console.error(' Erro ao enviar mensagem com rastreamento:', error);
  }
}

// Função para inicializar o socket
async function startSocket() {
  try {
    const {
      default: makeWASocket,
      Browsers,
      DisconnectReason,
      fetchLatestBaileysVersion,
      useMultiFileAuthState
    } = await loadBaileys();
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version, isLatest } = await fetchLatestBaileysVersion();

    console.log(`📡 Iniciando cliente WhatsApp Web na versão ${version.join('.')} (${isLatest ? 'atual' : 'fallback local'})`);

    sock = makeWASocket({
      auth: state,
      logger: pino({ level: 'silent' }) as any,
      printQRInTerminal: false,
      version,
      browser: Browsers.appropriate('Chrome'),
      connectTimeoutMs: 30000,
      keepAliveIntervalMs: 15000,
    });

    patchSocketTextNormalization(sock);

    // Definir socket no servidor administrativo
    adminServer.setSocket(sock);

    // Salvar credenciais quando atualizadas
    sock.ev.on('creds.update', saveCreds);

    // Escutar atualizações de conexão
    sock.ev.on('connection.update', async (update: any) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        // Limpar a tela e mostrar QR Code
        console.clear();
        console.log('\n');
        console.log(' ESCANEIE O QR CODE ABAIXO');
        console.log('   Abra o WhatsApp > Configurações >');
        console.log('   Aparelhos vinculados > Conectar');
        console.log('\n');
        // Usar tamanho pequeno para melhor leitura
        qrcode.generate(qr, { small: true });
        console.log('\n');
        console.log('⏳ Aguardando leitura do QR Code...\n');
        reconnectAttempts = 0;
        sessionResetCount = 0;
      }

      if (connection === 'close') {
        const error = lastDisconnect?.error as Boom;
        const statusCode = error?.output?.statusCode;
        const reasonCode = (error?.data as any)?.reason;
        const hasStoredSession = hasStoredAuthState();

        if ((reasonCode === '401' || statusCode === 401) && !isReconnecting) {
          reconnectAttempts++;
          sessionResetCount++;

          if (!canAttemptReconnect()) {
            console.log('⏳ Ignorando reconexão imediata para evitar loop de reinicialização.');
            return;
          }

          const codeLabel = reasonCode || String(statusCode || 'desconhecido');
          await restartSocketSession({
            clearAuth: true,
            reason: `Sessão do WhatsApp inválida ou desconectada (código ${codeLabel}). Gerando novo QR Code...`,
            delayMs: 2500
          });
          return;
        }

        if ((reasonCode === '405' || statusCode === 405) && !isReconnecting) {
          reconnectAttempts++;

          if (!canAttemptReconnect()) {
            console.log('⏳ Ignorando reconexão imediata para evitar loop de reinicialização.');
            return;
          }

          if (hasStoredSession) {
            sessionResetCount++;
            const codeLabel = reasonCode || String(statusCode || 'desconhecido');
            await restartSocketSession({
              clearAuth: true,
              reason: `Sessão do WhatsApp inválida ou desconectada (código ${codeLabel}). Limpando autenticação e solicitando novo QR Code...`,
              delayMs: 2500
            });
            return;
          }

          console.log('ℹ️ Conexão 405 sem credenciais salvas. Reiniciando pareamento sem limpar a pasta auth para permitir a geração do QR.');
          await restartSocketSession({
            clearAuth: false,
            delayMs: 6000
          });
          return;
        }

        if ((statusCode === DisconnectReason.connectionReplaced || statusCode === 440) && !isReconnecting) {
          reconnectAttempts = 0;
          isReconnecting = false;
          console.log('⚠️ Sessão encerrada por conflito (código 440). Há outra instância conectada com a mesma sessão do WhatsApp.');
          console.log('⚠️ Feche o outro processo/bot que esteja usando esta conta antes de iniciar novamente.');
          return;
        }

        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        console.log(
          'Conexão fechada devido a:',
          lastDisconnect?.error,
          ', reconectando:',
          shouldReconnect
        );

        if (shouldReconnect && !isReconnecting) {
          if (!canAttemptReconnect()) {
            console.log('⏳ Reconexão ignorada temporariamente para evitar loop.');
            return;
          }

          reconnectAttempts++;
          if (reconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
            console.log(`🔄 Reconectando (tentativa ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
            await restartSocketSession({
              clearAuth: false,
              delayMs: 2000
            });
          }
        }
      } else if (connection === 'open') {
        reconnectAttempts = 0;
        sessionResetCount = 0;
        isReconnecting = false;
        console.clear();
        console.log('\n');
        console.log(' BOT CONECTADO AO WHATSAPP COM SUCESSO!');
        console.log('');
        console.log('\n Sistema de Menu');
        console.log('    Menu e submenu estruturados');
        console.log('    Navegação textual numerada');
        console.log('    Roteamento automático para atendentes');
        console.log('\n️  Painel Administrativo:');
        console.log('    Acesse: http://localhost:3000');
        console.log('\n Painel do Atendente:');
        console.log('    Acesse: http://localhost:3000/attendant');
        console.log('\n Aguardando mensagens...\n');
      }
    });

    // Escutar mensagens recebidas
    sock.ev.on('messages.upsert', async ({ messages, type }: { messages: proto.IWebMessageInfo[], type: string }) => {
      if (type === 'notify') {
        // Se chegarem múltiplas mensagens de uma vez (offline), processar apenas a última de cada conversa
        if (messages.length > 1) {
          console.log(`${messages.length} mensagens recebidas simultaneamente (possivel sincronizacao offline)`);
        }
        
        for (const msg of messages) {
          // Usar debounce para evitar processar todas as mensagens offline
          await handleMessageWithDebounce(msg);
        }
      }
    });

    // Escutar interações com botões/listas
    sock.ev.on('messages.update', async (updates: any[]) => {
      for (const update of updates) {
        if (update.update.pollUpdates) {
          // Handle poll updates if needed
        }
      }
    });

    console.log(' Bot iniciado, aguardando conexão...');
  } catch (error) {
    console.error(' Erro ao iniciar o bot:', error);
    process.exit(1);
  }
}

// Iniciar o painel administrativo
adminServer.start();

// Obter referência ao attendance manager do servidor admin
attendanceManager = adminServer.attendanceManager;

// Obter referência ao user monitor do servidor admin
userMonitor = adminServer.userMonitor;

// Iniciar o bot
startSocket();

// Manter o processo rodando
process.on('SIGINT', () => {
  console.log('\n Encerrando o bot...');
  process.exit(0);
});



