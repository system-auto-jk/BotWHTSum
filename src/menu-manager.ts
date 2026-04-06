// Gerenciador de menus com persistencia em arquivo

import * as fs from 'fs';
import * as path from 'path';

export interface MenuItem {
  id: string;
  label: string;
  action?: 'submenu' | 'attendant' | 'message' | 'registration';
  submenuId?: string;
  attendantType?: string;
  message?: string;
  registrationPlan?: string;
}

export interface MenuLevel {
  id: string;
  title: string;
  message: string;
  items: MenuItem[];
}

export class MenuManager {
  private menusFile: string;
  private menus: Map<string, MenuLevel> = new Map();

  constructor(menusFilePath?: string) {
    this.menusFile = menusFilePath || path.join(__dirname, '../config/menus.json');
    this.loadMenus();
  }

  /**
   * Carrega menus do arquivo JSON
   */
  private loadMenus() {
    try {
      if (fs.existsSync(this.menusFile)) {
        const data = fs.readFileSync(this.menusFile, 'utf-8');
        const menusArray = JSON.parse(data) as MenuLevel[];
        
        // Converter array em Map
        menusArray.forEach(menu => {
          this.menus.set(menu.id, menu);
        });
        
        // Log removido para evitar poluicao a cada leitura de menu.
      } else {
        console.log('Arquivo de menus nao encontrado. Usando menus padrao.');
        this.initializeDefaultMenus();
      }
    } catch (error) {
      console.error('Erro ao carregar menus:', error);
      this.initializeDefaultMenus();
    }
  }

  /**
   * Salva menus no arquivo JSON
   */
  private saveMenus() {
    try {
      const menusArray = Array.from(this.menus.values());
      fs.writeFileSync(this.menusFile, JSON.stringify(menusArray, null, 2), 'utf-8');
      console.log('Menus salvos com sucesso');
    } catch (error) {
      console.error('Erro ao salvar menus:', error);
    }
  }

  /**
   * Inicializa menus padrao se nenhum arquivo existir
   */
  private initializeDefaultMenus() {
    // Menu Principal
    this.menus.set('main', {
      id: 'main',
      title: '🎯 Como posso ajudar você?',
      message: 'Bem-vindo à System Auto JK! 👋\n\nEstamos aqui para ajudar seu negócio a crescer com tecnologia.\n\nO que você gostaria de fazer?',
      items: [
        { id: 'services', label: '📋 Conheça nossos serviços', action: 'submenu', submenuId: 'services' },
        { id: 'pricing', label: '💰 Planos e preços', action: 'submenu', submenuId: 'pricing' },
        { id: 'faq', label: '❓ Dúvidas frequentes', action: 'submenu', submenuId: 'faq' },
        { id: 'contact', label: '📞 Falar com atendente', action: 'attendant', attendantType: 'commercial' }
      ]
    });

    // Menu Serviços
    this.menus.set('services', {
      id: 'services',
      title: '📋 Nossos Serviços',
      message: 'Oferecemos soluções completas para seu negócio:\n\nEscolha o serviço que te interessa:',
      items: [
        { id: 'bot_whatsapp', label: '🤖 Bot WhatsApp Inteligente', action: 'submenu', submenuId: 'bot_details' },
        { id: 'crm', label: '📊 CRM + Histórico de Pedidos', action: 'submenu', submenuId: 'crm_details' },
        { id: 'menu_digital', label: '🍕 Cardápio Digital', action: 'submenu', submenuId: 'menu_details' },
        { id: 'delivery', label: '🚗 Sistema de Entregadores', action: 'submenu', submenuId: 'delivery_details' },
        { id: 'integrations', label: '🔗 Integrações (API)', action: 'submenu', submenuId: 'integrations_details' },
        { id: 'custom', label: '⚡ Soluções Personalizadas', action: 'submenu', submenuId: 'custom_details' },
        { id: 'back_main', label: '⬅️ Voltar ao menu principal', action: 'submenu', submenuId: 'main' }
      ]
    });

    // Salvar os menus padrao
    this.saveMenus();
  }

  /**
   * Obtem um menu pelo ID
   */
  getMenu(menuId: string): MenuLevel | null {
    return this.menus.get(menuId) || null;
  }

  /**
   * Obtem todos os menus
   */
  getAllMenus(): MenuLevel[] {
    return Array.from(this.menus.values());
  }

  /**
   * Cria um novo menu
   */
  createMenu(menu: MenuLevel): boolean {
    try {
      if (this.menus.has(menu.id)) {
        console.log(`⚠️ Menu com ID "${menu.id}" já existe`);
        return false;
      }
      this.menus.set(menu.id, menu);
      this.saveMenus();
      console.log(`✅ Menu "${menu.id}" criado com sucesso`);
      return true;
    } catch (error) {
      console.error('❌ Erro ao criar menu:', error);
      return false;
    }
  }

  /**
   * Atualiza um menu existente
   */
  updateMenu(menuId: string, updates: Partial<MenuLevel>): boolean {
    try {
      const menu = this.menus.get(menuId);
      if (!menu) {
        console.log(`⚠️ Menu "${menuId}" não encontrado`);
        return false;
      }

      // Atualizar apenas os campos fornecidos
      if (updates.title !== undefined) menu.title = updates.title;
      if (updates.message !== undefined) menu.message = updates.message;
      if (updates.items !== undefined) menu.items = updates.items;

      this.saveMenus();
      console.log(`✅ Menu "${menuId}" atualizado com sucesso`);
      return true;
    } catch (error) {
      console.error('❌ Erro ao atualizar menu:', error);
      return false;
    }
  }

  /**
   * Deleta um menu
   */
  deleteMenu(menuId: string): boolean {
    try {
      if (!this.menus.has(menuId)) {
        console.log(`⚠️ Menu "${menuId}" não encontrado`);
        return false;
      }
      
      // Verificar se há menus que referenciam este menu
      let hasReferences = false;
      for (const [, menu] of this.menus) {
        if (menu.items.some(item => item.submenuId === menuId)) {
          hasReferences = true;
          break;
        }
      }

      if (hasReferences) {
        console.log(`⚠️ Não é possível deletar menu "${menuId}" pois ele é referenciado por outros menus`);
        return false;
      }

      this.menus.delete(menuId);
      this.saveMenus();
      console.log(`✅ Menu "${menuId}" deletado com sucesso`);
      return true;
    } catch (error) {
      console.error('❌ Erro ao deletar menu:', error);
      return false;
    }
  }

  /**
   * Adiciona um item a um menu
   */
  addItemToMenu(menuId: string, item: MenuItem): boolean {
    try {
      const menu = this.menus.get(menuId);
      if (!menu) {
        console.log(`⚠️ Menu "${menuId}" não encontrado`);
        return false;
      }

      // Verificar se item com mesmo ID já existe
      if (menu.items.some(i => i.id === item.id)) {
        console.log(`⚠️ Item com ID "${item.id}" já existe neste menu`);
        return false;
      }

      menu.items.push(item);
      this.saveMenus();
      console.log(`✅ Item "${item.id}" adicionado ao menu "${menuId}"`);
      return true;
    } catch (error) {
      console.error('❌ Erro ao adicionar item:', error);
      return false;
    }
  }

  /**
   * Remove um item de um menu
   */
  removeItemFromMenu(menuId: string, itemId: string): boolean {
    try {
      const menu = this.menus.get(menuId);
      if (!menu) {
        console.log(`⚠️ Menu "${menuId}" não encontrado`);
        return false;
      }

      const initialLength = menu.items.length;
      menu.items = menu.items.filter(item => item.id !== itemId);

      if (menu.items.length === initialLength) {
        console.log(`⚠️ Item "${itemId}" não encontrado neste menu`);
        return false;
      }

      this.saveMenus();
      console.log(`✅ Item "${itemId}" removido do menu "${menuId}"`);
      return true;
    } catch (error) {
      console.error('❌ Erro ao remover item:', error);
      return false;
    }
  }

  /**
   * Atualiza um item de um menu
   */
  updateMenuItemInMenu(menuId: string, itemId: string, updates: Partial<MenuItem>): boolean {
    try {
      const menu = this.menus.get(menuId);
      if (!menu) {
        console.log(`⚠️ Menu "${menuId}" não encontrado`);
        return false;
      }

      const item = menu.items.find(i => i.id === itemId);
      if (!item) {
        console.log(`⚠️ Item "${itemId}" não encontrado neste menu`);
        return false;
      }

      // Atualizar apenas os campos fornecidos
      if (updates.label !== undefined) item.label = updates.label;
      if (updates.action !== undefined) item.action = updates.action;
      if (updates.submenuId !== undefined) item.submenuId = updates.submenuId;
      if (updates.attendantType !== undefined) item.attendantType = updates.attendantType;
      if (updates.message !== undefined) item.message = updates.message;
      if (updates.registrationPlan !== undefined) item.registrationPlan = updates.registrationPlan;

      this.saveMenus();
      console.log(`✅ Item "${itemId}" do menu "${menuId}" atualizado com sucesso`);
      return true;
    } catch (error) {
      console.error('❌ Erro ao atualizar item:', error);
      return false;
    }
  }

  /**
   * Obtém um item específico de um menu
   */
  getMenuItemFromMenu(menuId: string, itemId: string): MenuItem | null {
    const menu = this.menus.get(menuId);
    if (!menu) return null;
    return menu.items.find(item => item.id === itemId) || null;
  }

  /**
   * Exporta todos os menus em formato JSON
   */
  exportMenusAsJson(): string {
    return JSON.stringify(Array.from(this.menus.values()), null, 2);
  }

  /**
   * Importa menus de um JSON
   */
  importMenusFromJson(jsonData: string): boolean {
    try {
      const menusArray = JSON.parse(jsonData) as MenuLevel[];
      this.menus.clear();
      menusArray.forEach(menu => {
        this.menus.set(menu.id, menu);
      });
      this.saveMenus();
      console.log(`✅ ${menusArray.length} menus importados com sucesso`);
      return true;
    } catch (error) {
      console.error('❌ Erro ao importar menus:', error);
      return false;
    }
  }
}

export default MenuManager;
