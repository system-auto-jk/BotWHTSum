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

const menuFile = path.join(__dirname, '../config/menus.json');

const fallbackMenus: MenuLevel[] = [
  {
    id: 'main',
    title: 'Menu Principal',
    message:
      '👋 Ola! Eu sou o assistente do Cardapio JK.\n\n🍕 Nosso sistema ajuda negocios de alimentacao a vender melhor com um cardapio digital mais pratico e profissional.\n\n🎯 Vou te mostrar o essencial para voce decidir sem perder tempo.',
    items: [
      { id: 'jk_overview', label: '🚀 Como o Cardapio JK ajuda meu negocio', action: 'submenu', submenuId: 'jk_overview' },
      { id: 'jk_plans', label: '💰 Ver planos e escolher o ideal', action: 'submenu', submenuId: 'jk_plans' },
      { id: 'jk_attendant_main', label: '📞 Falar com um especialista', action: 'attendant', attendantType: 'commercial' }
    ]
  }
];

const contentMessages: Record<string, string> = {
  jk_how_it_works:
    '✨ O Cardapio JK ajuda seu negocio a vender com mais clareza, acelerar o atendimento e reduzir erros no pedido.\n\n📲 O cliente entende melhor o cardapio, escolhe com mais facilidade e sua equipe trabalha com mais organizacao.\n\nSe fez sentido, o proximo passo ideal e ver o plano mais adequado para sua operacao.',
  jk_demo:
    '👀 Veja uma demonstracao do sistema neste link:\n\nhttps://minhaloja.systemautojk.com.br/\n\nSe voce gostar da experiencia, siga para os planos ou fale com um especialista.',
  jk_plan_basic_details:
    '🔹 Plano Basico\n\n- ideal para quem quer comecar rapido\n- organiza o atendimento\n- ajuda a profissionalizar a apresentacao do cardapio\n\n✅ Se esse plano faz sentido para seu momento, voce ja pode iniciar o cadastro.',
  jk_plan_professional_details:
    '⭐ Plano Profissional\n\n- ideal para quem quer mais estrutura\n- melhor para operacoes que buscam crescimento com controle\n- entrega uma base mais forte para escalar o atendimento\n\n✅ Se esse plano combina com seu negocio, voce ja pode iniciar o cadastro.'
};

function loadMenus(): MenuLevel[] {
  try {
    if (fs.existsSync(menuFile)) {
      return JSON.parse(fs.readFileSync(menuFile, 'utf-8')) as MenuLevel[];
    }
  } catch (_error) {
    // fallback
  }
  return fallbackMenus;
}

export class MenuSystem {
  static getMenu(menuId: string = 'main'): MenuLevel | null {
    return loadMenus().find(menu => menu.id === menuId) || null;
  }

  static getMenuItem(menuId: string, itemId: string): MenuItem | null {
    const menu = MenuSystem.getMenu(menuId);
    if (!menu) return null;
    return menu.items.find(item => item.id === itemId) || null;
  }

  static getGreetingMessage(): string {
    return MenuSystem.getMenu('main')?.message || '';
  }

  static getContentMessage(key: string): string {
    return contentMessages[key] || '';
  }

  static getAllMenuIds(): string[] {
    return loadMenus().map(menu => menu.id);
  }
}

export default MenuSystem;
