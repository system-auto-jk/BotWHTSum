// Sistema de cadastro/registro de clientes

export interface ClientRegistration {
  plan: 'basic' | 'professional' | 'custom';
  clientJid: string; // JID do cliente (número WhatsApp)
  clientPhone?: string; // Número extraído do JID para exibição
  name?: string;
  phone?: string;
  email?: string; // Email do cliente
  storeName?: string;
  niche?: string;
  address?: {
    street?: string;
    number?: string;
    neighborhood?: string;
    city?: string;
    state?: string;
    cep?: string;
  };
  serviceTypes?: string[]; // 'pickup', 'delivery', 'local'
  consultationTime?: string; // para plano personalizado
  step?: number; // Etapa atual do cadastro
  lastQuestion?: string; // Última pergunta feita
  cepConfirmed?: boolean; // Se o CEP foi confirmado como correto (não perguntar bairro novamente)
}

export class RegistrationSystem {
  private registrations: Map<string, ClientRegistration> = new Map();

  /**
   * Cria um novo registro com o plano escolhido
   */
  createRegistration(jid: string, plan: 'basic' | 'professional' | 'custom'): ClientRegistration {
    // Extrair número do JID (formato: 5511999999999@s.whatsapp.net)
    const phoneNumber = jid.split('@')[0];
    const formattedPhone = this.formatPhoneNumber(phoneNumber);
    
    const registration: ClientRegistration = {
      plan,
      clientJid: jid,
      clientPhone: formattedPhone,
      step: 1, // Começar pelo nome
      lastQuestion: 'name'
    };
    this.registrations.set(jid, registration);
    return registration;
  }

  /**
   * Formata o número de telefone para exibição
   */
  private formatPhoneNumber(phone: string): string {
    // Remove caracteres não numéricos
    const cleaned = phone.replace(/\D/g, '');
    
    // Formato: (XX) 9XXXX-XXXX para números com 11 dígitos (BR)
    if (cleaned.length === 11) {
      return `(${cleaned.slice(0, 2)}) ${cleaned.slice(2, 7)}-${cleaned.slice(7)}`;
    }
    
    // Retorna como está se não for o formato esperado
    return phone;
  }

  /**
   * Obtém o registro de um cliente
   */
  getRegistration(jid: string): ClientRegistration | undefined {
    return this.registrations.get(jid);
  }

  /**
   * Verifica se um cliente está em processo de registro
   */
  isRegistering(jid: string): boolean {
    return this.registrations.has(jid);
  }

  /**
   * Atualiza o registro com a resposta do cliente
   */
  updateRegistration(jid: string, answer: string): { valid: boolean; nextQuestion?: string; message?: string } {
    const registration = this.registrations.get(jid);
    if (!registration) {
      return { valid: false, message: 'Nenhum registro ativo' };
    }

    switch (registration.lastQuestion) {
      case 'name':
        if (answer.trim().length < 3) {
          return { valid: false, message: 'Nome deve ter pelo menos 3 caracteres' };
        }
        registration.name = answer;
        registration.lastQuestion = 'phone_confirmation';
        return { valid: true, nextQuestion: 'phone_confirmation' };

      case 'phone_confirmation':
         // Validar se é um número ou "SIM"
         if (answer.toUpperCase() === 'SIM') {
           // Usar o número do cliente
           if (registration.clientPhone) {
             registration.phone = registration.clientPhone;
           } else {
             return { valid: false, message: 'Erro ao obter o número de telefone' };
           }
         } else if (!/^\d{10,}$/.test(answer.replace(/\D/g, ''))) {
           return { valid: false, message: 'Número de telefone inválido' };
         } else {
           registration.phone = answer;
         }
         registration.lastQuestion = 'email';
         return { valid: true, nextQuestion: 'email' };

      case 'phone_alternative':
         // Validar se é um número alternativo
         if (!/^\d{10,}$/.test(answer.replace(/\D/g, ''))) {
           return { valid: false, message: 'Número de telefone inválido' };
         }
         registration.phone = answer;
         registration.lastQuestion = 'email';
         return { valid: true, nextQuestion: 'email' };

      case 'email':
         // Validar email
         const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
         if (!emailRegex.test(answer.trim())) {
           return { valid: false, message: 'Email inválido' };
         }
         registration.email = answer.trim();
         registration.lastQuestion = 'store_name';
         return { valid: true, nextQuestion: 'store_name' };

      case 'store_name':
        if (answer.trim().length < 3) {
          return { valid: false, message: 'Nome da loja deve ter pelo menos 3 caracteres' };
        }
        registration.storeName = answer;
        registration.lastQuestion = 'niche';
        return { valid: true, nextQuestion: 'niche' };

      case 'niche':
        if (answer.trim().length < 3) {
          return { valid: false, message: 'Nicho deve ser válido' };
        }
        registration.niche = answer;
        registration.lastQuestion = 'address_cep';
        return { valid: true, nextQuestion: 'address_cep' };

      case 'niche_custom':
        // Nicho customizado digitado pelo usuário
        if (answer.trim().length < 3) {
          return { valid: false, message: 'Nicho deve ter pelo menos 3 caracteres' };
        }
        registration.niche = answer;
        registration.lastQuestion = 'address_cep';
        return { valid: true, nextQuestion: 'address_cep' };

      case 'address_cep':
        // Este caso é tratado manualmente em index.ts com busca de CEP
        // Nunca deve chegar aqui
        return { valid: false, message: 'Erro ao processar CEP' };

      case 'address_street':
        // Este caso é tratado manualmente em index.ts
        // Nunca deve chegar aqui
        return { valid: false, message: 'Erro ao processar rua' };

      case 'address_number':
        // Este caso é tratado manualmente em index.ts
        // Nunca deve chegar aqui
        return { valid: false, message: 'Erro ao processar número' };

      case 'address_neighborhood':
        // Este caso é tratado manualmente em index.ts
        // Nunca deve chegar aqui
        return { valid: false, message: 'Erro ao processar bairro' };

      case 'cep_confirmation':
        // Confirmação de CEP é tratada manualmente em index.ts
        // Nunca deve chegar aqui
        return { valid: false, message: 'Erro ao confirmar CEP' };

      case 'service_types':
        // Aceita múltiplas opções: retirada, delivery, local
        const validServices = ['retirada', 'delivery', 'local'];
        const services = answer.toLowerCase()
          .split(',')
          .map(s => s.trim())
          .filter(s => s.length > 0);
        
        if (services.length === 0) {
          return { valid: false, message: 'Selecione pelo menos um serviço' };
        }
        
        // Normalizar os serviços
        const normalizedServices: string[] = [];
        for (const s of services) {
          if (s.includes('retirada')) {
            if (!normalizedServices.includes('retirada')) normalizedServices.push('retirada');
          } else if (s.includes('delivery')) {
            if (!normalizedServices.includes('delivery')) normalizedServices.push('delivery');
          } else if (s.includes('local') || s.includes('atendimento')) {
            if (!normalizedServices.includes('local')) normalizedServices.push('local');
          } else {
            return { valid: false, message: 'Serviço inválido: ' + s };
          }
        }
        
        if (normalizedServices.length === 0) {
          return { valid: false, message: 'Nenhum serviço válido foi selecionado' };
        }
        
        registration.serviceTypes = normalizedServices;
         registration.lastQuestion = 'confirmation';
         return { valid: true, nextQuestion: 'confirmation' };

      case 'consultation_time':
         if (answer.trim().length < 5) {
           return { valid: false, message: 'Horário deve ser válido' };
         }
         registration.consultationTime = answer;
         registration.lastQuestion = 'confirmation';
         return { valid: true, nextQuestion: 'confirmation' };

       case 'confirmation':
         // A confirmação é apenas para exibir o resumo
         // O usuário deve digitar "confirmar" para finalizar
         return { valid: true, nextQuestion: 'confirmation' };

       default:
         return { valid: false, message: 'Erro no processo de cadastro' };
      }
      }

  /**
   * Gera um resumo formatado do cadastro
   */
  generateSummary(jid: string): string {
    const registration = this.registrations.get(jid);
    if (!registration) return '';

    let summary = '📋 RESUMO DO CADASTRO\n';
    summary += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';

    summary += `💰 PLANO: ${registration.plan.toUpperCase()}\n`;
    if (registration.plan === 'basic') summary += '   (R$ 49,90/mês)\n';
    else if (registration.plan === 'professional') summary += '   (R$ 79,90/mês)\n';
    summary += '\n';

    if (registration.name) summary += `👤 Nome: ${registration.name}\n`;
    if (registration.phone) summary += `📱 Telefone: ${registration.phone}\n`;
    if (registration.email) summary += `📧 Email: ${registration.email}\n`;
    if (registration.storeName) summary += `🏪 Loja: ${registration.storeName}\n`;
    if (registration.niche) summary += `🏷️  Nicho: ${registration.niche}\n`;

    if (registration.address) {
      summary += '\n📍 ENDEREÇO:\n';
      if (registration.address.cep) summary += `   CEP: ${registration.address.cep}\n`;
      if (registration.address.street) summary += `   Rua: ${registration.address.street}\n`;
      if (registration.address.number) summary += `   Nº ${registration.address.number}\n`;
      if (registration.address.neighborhood) summary += `   Bairro: ${registration.address.neighborhood}\n`;
    }

    if (registration.serviceTypes && registration.serviceTypes.length > 0) {
      summary += `\n🚚 SERVIÇOS: ${registration.serviceTypes.join(', ')}\n`;
    }

    if (registration.consultationTime) {
      summary += `\n📞 MELHOR HORA PARA CONTATO: ${registration.consultationTime}\n`;
    }

    summary += '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    summary += 'Clique nos botões abaixo para confirmar ou cancelar';

    return summary;
  }

  /**
   * Finaliza o registro e o remove do mapa
   */
  finalizeRegistration(jid: string): ClientRegistration | null {
    const registration = this.registrations.get(jid);
    if (registration) {
      this.registrations.delete(jid);
    }
    return registration || null;
  }

  /**
   * Cancela o registro
   */
  cancelRegistration(jid: string): boolean {
    return this.registrations.delete(jid);
  }
}

export default new RegistrationSystem();
