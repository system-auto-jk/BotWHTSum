import type { WASocket } from 'baileys';
import { RegistrationHandler, RegistrationPlan } from './registration-handler';

export interface RegistrationSession {
    jid: string;
    clientName: string;
    plan: string;
    currentFieldIndex: number;
    formData: Record<string, string>;
    startedAt: number;
}

export class WhatsAppRegistrationFlow {
    private registrationHandler: RegistrationHandler;
    private activeSessions: Map<string, RegistrationSession> = new Map();
    private sock: WASocket | null = null;

    constructor(registrationHandler: RegistrationHandler) {
        this.registrationHandler = registrationHandler;
    }

    public setSocket(sock: WASocket) {
        this.sock = sock;
    }

    /**
     * Inicia um fluxo de cadastro
     */
    public async startRegistrationFlow(
        jid: string,
        clientName: string,
        planId: string
    ): Promise<boolean> {
        const plan = this.registrationHandler.getPlan(planId);
        if (!plan || !plan.active) {
            return false;
        }

        // Criar sessão de cadastro
        const session: RegistrationSession = {
            jid,
            clientName,
            plan: planId,
            currentFieldIndex: 0,
            formData: {},
            startedAt: Date.now()
        };

        this.activeSessions.set(jid, session);

        // Enviar primeira pergunta
        await this.sendNextField(jid);

        return true;
    }

    /**
     * Enviar próximo campo do formulário
     */
    private async sendNextField(jid: string): Promise<void> {
        const session = this.activeSessions.get(jid);
        if (!session) return;

        const plan = this.registrationHandler.getPlan(session.plan);
        if (!plan) return;

        // Se finalizou todos os campos
        if (session.currentFieldIndex >= plan.fields.length) {
            await this.completeRegistration(jid);
            return;
        }

        const field = plan.fields[session.currentFieldIndex];
        const progress = `[${session.currentFieldIndex + 1}/${plan.fields.length}]`;

        let message = `${progress} ${field.label}\n`;
        message += `${field.placeholder || ''}\n`;

        if (field.type === 'select' && field.options) {
            message += '\nOpções:\n';
            field.options.forEach((option, index) => {
                message += `${index + 1}. ${option}\n`;
            });
            message += '\nDigite o número da opção escolhida.';
        } else if (field.required) {
            message += '\n*(Campo obrigatório)';
        }

        if (this.sock) {
            await this.sock.sendMessage(jid, {
                text: message
            });
        }
    }

    /**
     * Processar resposta do usuário
     */
    public async processUserResponse(jid: string, userMessage: string): Promise<boolean> {
        const session = this.activeSessions.get(jid);
        if (!session) return false;

        const plan = this.registrationHandler.getPlan(session.plan);
        if (!plan) return false;

        const field = plan.fields[session.currentFieldIndex];

        // Validar resposta
        if (!this.validateField(field, userMessage)) {
            if (this.sock) {
                await this.sock.sendMessage(jid, {
                    text: `❌ Resposta inválida para "${field.label}".\n\nPor favor, tente novamente.`
                });
            }
            return false;
        }

        // Armazenar resposta (select salva o texto da opção, não o índice)
        let normalizedValue = userMessage;
        if (field.type === 'select' && field.options) {
            const index = parseInt(userMessage) - 1;
            if (index >= 0 && index < field.options.length) {
                normalizedValue = field.options[index];
            }
        }

        session.formData[field.name] = normalizedValue;
        session.currentFieldIndex++;

        // Enviar próximo campo
        await this.sendNextField(jid);

        return true;
    }

    /**
     * Validar campo
     */
    private validateField(field: any, value: string): boolean {
        if (!value || value.trim().length === 0) {
            return !field.required;
        }

        switch (field.type) {
            case 'email':
                return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
            case 'phone':
                return /^\d{10,}$/.test(value.replace(/\D/g, ''));
            case 'number':
                return /^\d+$/.test(value);
            case 'select':
                const index = parseInt(value) - 1;
                return field.options && index >= 0 && index < field.options.length;
            default:
                return true;
        }
    }

    /**
     * Completar cadastro
     */
    private async completeRegistration(jid: string): Promise<void> {
        const session = this.activeSessions.get(jid);
        if (!session) return;

        const plan = this.registrationHandler.getPlan(session.plan);
        if (!plan) return;

        // Mapear dados do formulário
        const registrationData = {
            clientJid: jid,
            clientName: this.resolveClientNameFromForm(session),
            clientPhone: '',
            clientEmail: '',
            document: '',
            address: '',
            plan: session.plan,
            additionalInfo: ''
        };

        // Extrair dados com base nos nomes dos campos
        Object.entries(session.formData).forEach(([fieldName, value]) => {
            if (fieldName.includes('phone')) registrationData.clientPhone = value;
            if (fieldName.includes('email')) registrationData.clientEmail = value;
            if (fieldName.includes('document') || fieldName.includes('cnpj')) registrationData.document = value;
            if (fieldName.includes('address')) registrationData.address = value;
        });

        // Criar registro
        const registration = this.registrationHandler.createRegistration(
            jid,
            registrationData.clientName,
            registrationData
        );

        console.log('📝 [WhatsApp Registration] Cadastro criado com sucesso!', {
            id: registration.id,
            cliente: registration.clientName,
            plano: registration.plan,
            timestamp: new Date(registration.timestamp).toLocaleString('pt-BR')
        });

        // Enviar confirmação ao cliente
        if (this.sock) {
            let message = '✅ *Cadastro recebido com sucesso!*\n\n';
            message += 'Seus dados foram enviados para análise.\n';
            message += 'Você será notificado assim que seu cadastro for aprovado.\n\n';
            message += 'ID do Cadastro: ' + registration.id;

            await this.sock.sendMessage(jid, {
                text: message
            });
        }

        // Limpar sessão
        this.activeSessions.delete(jid);
    }

    private resolveClientNameFromForm(session: RegistrationSession): string {
        const addCandidate = (value: unknown, bucket: string[]) => {
            if (typeof value !== 'string') return;
            const text = value.trim();
            if (text) bucket.push(text);
        };

        const candidates: string[] = [];
        addCandidate(session.formData.fullName, candidates);
        addCandidate(session.formData.businessName, candidates);
        addCandidate(session.formData.ownerName, candidates);
        addCandidate(session.formData.name, candidates);
        addCandidate(session.clientName, candidates);

        return candidates[0] || 'Cliente';
    }

    /**
     * Cancelar cadastro em andamento
     */
    public async cancelRegistration(jid: string): Promise<void> {
        const session = this.activeSessions.get(jid);
        if (!session) return;

        this.activeSessions.delete(jid);

        if (this.sock) {
            await this.sock.sendMessage(jid, {
                text: '❌ Cadastro cancelado.\n\nDigite "cadastro" novamente para começar um novo cadastro.'
            });
        }
    }

    /**
     * Obter sessão ativa
     */
    public getSession(jid: string): RegistrationSession | undefined {
        return this.activeSessions.get(jid);
    }

    /**
     * Obter todas as sessões
     */
    public getAllSessions(): RegistrationSession[] {
        return Array.from(this.activeSessions.values());
    }

    /**
     * Limpar sessões expiradas (mais de 1 hora)
     */
    public cleanupExpiredSessions(): void {
        const now = Date.now();
        const ONE_HOUR = 60 * 60 * 1000;

        this.activeSessions.forEach((session, jid) => {
            if (now - session.startedAt > ONE_HOUR) {
                this.activeSessions.delete(jid);
            }
        });
    }

    /**
     * Renderizar plano em formato de menu para o usuário
     */
    public async showRegistrationPlans(jid: string): Promise<void> {
        const plans = this.registrationHandler.getActivePlans();

        let message = '📋 *Escolha um plano de cadastro:*\n\n';

        plans.forEach((plan, index) => {
            message += `${index + 1}. *${plan.name}*\n`;
            message += `   ${plan.description}\n`;
            message += `   ${plan.fields.length} campos\n\n`;
        });

        message += 'Digite o número do plano escolhido.';

        if (this.sock) {
            await this.sock.sendMessage(jid, {
                text: message
            });
        }
    }

    /**
     * Iniciar cadastro a partir da seleção do plano
     */
    public async selectPlanFromUser(jid: string, clientName: string, planIndex: number): Promise<boolean> {
        const plans = this.registrationHandler.getActivePlans();

        if (planIndex < 1 || planIndex > plans.length) {
            if (this.sock) {
                await this.sock.sendMessage(jid, {
                    text: '❌ Opção inválida. Por favor, escolha um plano válido.'
                });
            }
            return false;
        }

        const selectedPlan = plans[planIndex - 1];
        return this.startRegistrationFlow(jid, clientName, selectedPlan.id);
    }

    /**
     * Gerar relatório de cadastro
     */
    public generateRegistrationReport(): string {
        const stats = this.registrationHandler.getRegistrationStats();
        const activeSessions = this.getAllSessions();

        let report = '📊 *Relatório de Cadastros*\n\n';
        report += `Total: ${stats.total}\n`;
        report += `Pendentes: ${stats.pending}\n`;
        report += `Aprovados: ${stats.approved}\n`;
        report += `Rejeitados: ${stats.rejected}\n\n`;
        report += `Sessões ativas: ${activeSessions.length}`;

        return report;
    }
}
