import * as fs from 'fs';
import * as path from 'path';

// Simples gerador de UUID sem dependência externa
function generateUUID(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

export interface RegistrationData {
    id: string;
    clientJid: string;
    clientName: string;
    clientPhone: string;
    clientEmail: string;
    document: string;
    address: string;
    plan: string;
    additionalInfo?: string;
    status: 'pending' | 'approved' | 'rejected';
    timestamp: number;
    updatedAt: number;
    updatedBy?: string;
    internalNotes?: string;
    history: RegistrationHistoryEntry[];
    rejectionReason?: string;
    approvedBy?: string;
    approvedAt?: number;
}

export interface RegistrationHistoryEntry {
    type: 'created' | 'updated' | 'approved' | 'rejected' | 'deleted';
    timestamp: number;
    actor: string;
    summary: string;
}

export interface RegistrationField {
    name: string;
    label: string;
    type: 'text' | 'email' | 'phone' | 'number' | 'textarea' | 'select';
    required: boolean;
    options?: string[];
    placeholder?: string;
}

export interface RegistrationPlan {
    id: string;
    name: string;
    description: string;
    fields: RegistrationField[];
    active: boolean;
}

export class RegistrationHandler {
    private registrationsDir: string;
    private plansFile: string;
    private registrations: Map<string, RegistrationData> = new Map();
    private plans: Map<string, RegistrationPlan> = new Map();

    constructor() {
        this.registrationsDir = path.join(__dirname, '../data/registrations');
        this.plansFile = path.join(__dirname, '../config/registration-plans.json');
        
        this.ensureDirectories();
        this.loadRegistrations();
        this.loadPlans();
    }

    private ensureDirectories() {
        if (!fs.existsSync(this.registrationsDir)) {
            fs.mkdirSync(this.registrationsDir, { recursive: true });
        }
        const configDir = path.dirname(this.plansFile);
        if (!fs.existsSync(configDir)) {
            fs.mkdirSync(configDir, { recursive: true });
        }
    }

    private loadRegistrations() {
        try {
            const indexFile = path.join(this.registrationsDir, 'index.json');
            if (fs.existsSync(indexFile)) {
                const data = fs.readFileSync(indexFile, 'utf-8');
                const registrations = JSON.parse(data);
                registrations.forEach((reg: RegistrationData) => {
                    const normalized = this.normalizeRegistrationRecord(reg);
                    this.registrations.set(normalized.id, normalized);
                });
                this.normalizeLoadedClientNames();
                console.log(`✅ [RegistrationHandler] Carregados ${registrations.length} cadastros do arquivo`);
            } else {
                console.log(`ℹ️ [RegistrationHandler] Arquivo de cadastros não encontrado. Iniciando vazio.`);
            }
        } catch (error) {
            console.error('❌ [RegistrationHandler] Erro ao carregar registros:', error);
        }
    }

    private loadPlans() {
        try {
            if (!fs.existsSync(this.plansFile)) {
                this.createDefaultPlans();
                return;
            }

            const data = fs.readFileSync(this.plansFile, 'utf-8');
            const plans = JSON.parse(data);
            plans.forEach((plan: RegistrationPlan) => {
                this.plans.set(plan.id, plan);
            });
        } catch (error) {
            console.error('Erro ao carregar planos:', error);
            this.createDefaultPlans();
        }
    }

    private createDefaultPlans() {
        const defaultPlans: RegistrationPlan[] = [
            {
                id: 'basic',
                name: 'Plano Básico',
                description: 'Cadastro básico de cliente',
                active: true,
                fields: [
                    { name: 'fullName', label: 'Nome Completo', type: 'text', required: true },
                    { name: 'email', label: 'Email', type: 'email', required: true },
                    { name: 'phone', label: 'Telefone', type: 'phone', required: true },
                    { name: 'address', label: 'Endereço', type: 'textarea', required: true }
                ]
            },
            {
                id: 'restaurant',
                name: 'Cardápio Digital',
                description: 'Cadastro para restaurantes no cardápio digital',
                active: true,
                fields: [
                    { name: 'businessName', label: 'Nome do Estabelecimento', type: 'text', required: true },
                    { name: 'ownerName', label: 'Nome do Proprietário', type: 'text', required: true },
                    { name: 'email', label: 'Email', type: 'email', required: true },
                    { name: 'phone', label: 'Telefone', type: 'phone', required: true },
                    { name: 'document', label: 'CNPJ/CPF', type: 'text', required: true },
                    { name: 'address', label: 'Endereço Completo', type: 'textarea', required: true },
                    { name: 'cuisine', label: 'Tipo de Culinária', type: 'select', required: true, options: ['Brasileira', 'Italiana', 'Japonesa', 'Mexicana', 'Pizzaria', 'Hambúrguer', 'Vegetariana', 'Outro'] },
                    { name: 'deliveryArea', label: 'Área de Entrega', type: 'textarea', required: false }
                ]
            },
            {
                id: 'service',
                name: 'Prestador de Serviço',
                description: 'Cadastro para prestadores de serviço',
                active: true,
                fields: [
                    { name: 'businessName', label: 'Nome da Empresa', type: 'text', required: true },
                    { name: 'ownerName', label: 'Nome do Responsável', type: 'text', required: true },
                    { name: 'email', label: 'Email', type: 'email', required: true },
                    { name: 'phone', label: 'Telefone', type: 'phone', required: true },
                    { name: 'document', label: 'CNPJ/CPF', type: 'text', required: true },
                    { name: 'address', label: 'Endereço', type: 'textarea', required: true },
                    { name: 'serviceType', label: 'Tipo de Serviço', type: 'text', required: true },
                    { name: 'serviceArea', label: 'Área de Atuação', type: 'textarea', required: true }
                ]
            }
        ];

        this.plans.clear();
        defaultPlans.forEach(plan => {
            this.plans.set(plan.id, plan);
        });

        this.savePlans();
    }

    private savePlans() {
        try {
            const configDir = path.dirname(this.plansFile);
            if (!fs.existsSync(configDir)) {
                fs.mkdirSync(configDir, { recursive: true });
            }
            fs.writeFileSync(this.plansFile, JSON.stringify(Array.from(this.plans.values()), null, 2));
        } catch (error) {
            console.error('Erro ao salvar planos:', error);
        }
    }

    private saveRegistrations() {
        try {
            const indexFile = path.join(this.registrationsDir, 'index.json');
            fs.writeFileSync(indexFile, JSON.stringify(Array.from(this.registrations.values()), null, 2));
            console.log(`💾 [RegistrationHandler] ${this.registrations.size} cadastro(s) salvado(s) em ${indexFile}`);
        } catch (error) {
            console.error('❌ [RegistrationHandler] Erro ao salvar registros:', error);
        }
    }

    private normalizeLoadedClientNames(): void {
        let changed = false;

        for (const [id, reg] of this.registrations.entries()) {
            const normalized = (reg.clientName || '').trim().toLowerCase();
            const isPlaceholder = !normalized
                || normalized === 'sem nome'
                || normalized === 'waiting'
                || normalized.startsWith('waiting_')
                || normalized.includes('waiting_name');

            if (!isPlaceholder) {
                continue;
            }

            const storeMatch = (reg.additionalInfo || '').match(/Loja:\s*([^,\n]+)/i);
            const resolvedName = (storeMatch?.[1] || '').trim()
                || reg.clientPhone
                || reg.clientJid.split('@')[0]
                || 'Cliente';

            reg.clientName = resolvedName;
            reg.updatedAt = reg.updatedAt || reg.timestamp || Date.now();
            this.registrations.set(id, reg);
            changed = true;
        }

        if (changed) {
            this.saveRegistrations();
        }
    }

    private normalizeRegistrationRecord(reg: RegistrationData): RegistrationData {
        const timestamp = Number(reg?.timestamp) > 0 ? Number(reg.timestamp) : Date.now();
        const updatedAt = Number((reg as any)?.updatedAt) > 0 ? Number((reg as any).updatedAt) : timestamp;
        const history = Array.isArray((reg as any)?.history)
            ? (reg as any).history
                .filter((entry: any) => entry && typeof entry === 'object')
                .map((entry: any) => ({
                    type: ['created', 'updated', 'approved', 'rejected', 'deleted'].includes(entry.type)
                        ? entry.type
                        : 'updated',
                    timestamp: Number(entry.timestamp) > 0 ? Number(entry.timestamp) : updatedAt,
                    actor: typeof entry.actor === 'string' && entry.actor.trim() ? entry.actor.trim() : 'system',
                    summary: typeof entry.summary === 'string' && entry.summary.trim() ? entry.summary.trim() : 'Atualizacao registrada'
                }))
            : [];

        return {
            ...reg,
            clientJid: reg.clientJid || '',
            clientName: reg.clientName || 'Cliente',
            clientPhone: reg.clientPhone || '',
            clientEmail: reg.clientEmail || '',
            document: reg.document || '',
            address: reg.address || '',
            plan: reg.plan || 'basic',
            additionalInfo: reg.additionalInfo || '',
            status: ['pending', 'approved', 'rejected'].includes(reg.status) ? reg.status : 'pending',
            timestamp,
            updatedAt,
            updatedBy: reg.updatedBy || undefined,
            internalNotes: typeof (reg as any)?.internalNotes === 'string' ? (reg as any).internalNotes.trim() : undefined,
            history: history.length > 0 ? history : [{
                type: 'created',
                timestamp,
                actor: 'system',
                summary: 'Cadastro importado para a base atual'
            }]
        };
    }

    private buildChangedFieldsSummary(previous: RegistrationData, next: Partial<RegistrationData>): string {
        const labelMap: Record<string, string> = {
            clientName: 'nome',
            clientJid: 'jid',
            clientPhone: 'telefone',
            clientEmail: 'email',
            document: 'documento',
            address: 'endereco',
            plan: 'plano',
            status: 'status',
            additionalInfo: 'informacoes adicionais',
            internalNotes: 'notas internas',
            rejectionReason: 'motivo da rejeicao'
        };

        const changed = Object.entries(next)
            .filter(([key, value]) => {
                if (!(key in labelMap)) return false;
                return (previous as any)[key] !== value;
            })
            .map(([key]) => labelMap[key]);

        return changed.length > 0
            ? `Campos atualizados: ${changed.join(', ')}`
            : 'Cadastro atualizado sem alteracoes relevantes detectadas';
    }

    private appendHistory(
        registration: RegistrationData,
        entry: Omit<RegistrationHistoryEntry, 'timestamp'> & { timestamp?: number }
    ): RegistrationData {
        const timestamp = entry.timestamp || Date.now();
        const nextEntry: RegistrationHistoryEntry = {
            type: entry.type,
            actor: entry.actor,
            summary: entry.summary,
            timestamp
        };

        return {
            ...registration,
            updatedAt: timestamp,
            updatedBy: entry.actor,
            history: Array.isArray(registration.history) ? [...registration.history, nextEntry] : [nextEntry]
        };
    }
    // Registration Management
    public createRegistration(
        clientJid: string,
        clientName: string,
        data: Partial<RegistrationData>
    ): RegistrationData {
        const now = Date.now();
        const registration: RegistrationData = {
            id: generateUUID(),
            clientJid,
            clientName,
            clientPhone: data.clientPhone || '',
            clientEmail: data.clientEmail || '',
            document: data.document || '',
            address: data.address || '',
            plan: data.plan || 'basic',
            additionalInfo: data.additionalInfo,
            status: 'pending',
            timestamp: now,
            updatedAt: now,
            updatedBy: 'system',
            internalNotes: data.internalNotes || '',
            history: [{
                type: 'created',
                timestamp: now,
                actor: 'system',
                summary: `Cadastro criado no plano ${data.plan || 'basic'}`
            }]
        };

        this.registrations.set(registration.id, registration);
        this.saveRegistrations();

        return registration;
    }

    public getRegistration(registrationId: string): RegistrationData | undefined {
        return this.registrations.get(registrationId);
    }

    public getAllRegistrations(): RegistrationData[] {
        return Array.from(this.registrations.values());
    }

    public getRegistrationsByStatus(status: 'pending' | 'approved' | 'rejected'): RegistrationData[] {
        return Array.from(this.registrations.values()).filter(r => r.status === status);
    }

    public getRegistrationsByClient(clientJid: string): RegistrationData[] {
        return Array.from(this.registrations.values()).filter(r => r.clientJid === clientJid);
    }

    // Verificar se cliente tem cadastro aprovado em um plano específico
    public hasApprovedRegistrationForPlan(clientJid: string, plan: string): RegistrationData | undefined {
        return Array.from(this.registrations.values()).find(r => 
            r.clientJid === clientJid && 
            r.plan === plan && 
            r.status === 'approved'
        );
    }

    public updateRegistration(registrationId: string, updates: Partial<RegistrationData>): boolean {
        const registration = this.registrations.get(registrationId);
        if (!registration) return false;

        const cleanedUpdates: Partial<RegistrationData> = {
            ...updates,
            clientName: typeof updates.clientName === 'string' ? updates.clientName.trim() : updates.clientName,
            clientJid: typeof updates.clientJid === 'string' ? updates.clientJid.trim() : updates.clientJid,
            clientPhone: typeof updates.clientPhone === 'string' ? updates.clientPhone.trim() : updates.clientPhone,
            clientEmail: typeof updates.clientEmail === 'string' ? updates.clientEmail.trim() : updates.clientEmail,
            document: typeof updates.document === 'string' ? updates.document.trim() : updates.document,
            address: typeof updates.address === 'string' ? updates.address.trim() : updates.address,
            additionalInfo: typeof updates.additionalInfo === 'string' ? updates.additionalInfo.trim() : updates.additionalInfo,
            internalNotes: typeof updates.internalNotes === 'string' ? updates.internalNotes.trim() : updates.internalNotes,
            updatedBy: typeof updates.updatedBy === 'string' && updates.updatedBy.trim() ? updates.updatedBy.trim() : 'admin'
        };

        const merged = this.normalizeRegistrationRecord({
            ...registration,
            ...cleanedUpdates
        } as RegistrationData);
        const updated = this.appendHistory(merged, {
            type: 'updated',
            actor: cleanedUpdates.updatedBy || 'admin',
            summary: this.buildChangedFieldsSummary(registration, cleanedUpdates)
        });

        this.registrations.set(registrationId, updated);
        this.saveRegistrations();

        return true;
    }

    public approveRegistration(registrationId: string, approvedBy: string): boolean {
        const registration = this.registrations.get(registrationId);
        if (!registration) return false;

        registration.status = 'approved';
        registration.approvedBy = approvedBy;
        registration.approvedAt = Date.now();
        const updated = this.appendHistory(registration, {
            type: 'approved',
            actor: approvedBy || 'admin',
            summary: `Cadastro aprovado por ${approvedBy || 'admin'}`
        });

        this.registrations.set(registrationId, updated);
        this.saveRegistrations();

        return true;
    }

    public rejectRegistration(registrationId: string, reason: string): boolean {
        const registration = this.registrations.get(registrationId);
        if (!registration) return false;

        registration.status = 'rejected';
        registration.rejectionReason = reason;
        const updated = this.appendHistory(registration, {
            type: 'rejected',
            actor: 'admin',
            summary: `Cadastro rejeitado. Motivo: ${reason}`
        });

        this.registrations.set(registrationId, updated);
        this.saveRegistrations();

        return true;
    }

    public deleteRegistration(registrationId: string): boolean {
        const registration = this.registrations.get(registrationId);
        if (registration) {
            const updated = this.appendHistory(registration, {
                type: 'deleted',
                actor: 'admin',
                summary: 'Cadastro removido da base ativa'
            });
            this.registrations.set(registrationId, updated);
        }

        const result = this.registrations.delete(registrationId);
        if (result) {
            this.saveRegistrations();
        }
        return result;
    }

    // Plan Management
    public getPlan(planId: string): RegistrationPlan | undefined {
        return this.plans.get(planId);
    }

    public getAllPlans(): RegistrationPlan[] {
        return Array.from(this.plans.values());
    }

    public getActivePlans(): RegistrationPlan[] {
        return Array.from(this.plans.values()).filter(p => p.active);
    }

    public createPlan(plan: RegistrationPlan): boolean {
        if (this.plans.has(plan.id)) return false;

        this.plans.set(plan.id, plan);
        this.savePlans();

        return true;
    }

    public updatePlan(planId: string, updates: Partial<RegistrationPlan>): boolean {
        const plan = this.plans.get(planId);
        if (!plan) return false;

        const updated = { ...plan, ...updates, id: plan.id };
        this.plans.set(planId, updated);
        this.savePlans();

        return true;
    }

    public deletePlan(planId: string): boolean {
        const result = this.plans.delete(planId);
        if (result) {
            this.savePlans();
        }
        return result;
    }

    // Statistics
    public getRegistrationStats() {
        const all = this.getAllRegistrations();
        return {
            total: all.length,
            pending: all.filter(r => r.status === 'pending').length,
            approved: all.filter(r => r.status === 'approved').length,
            rejected: all.filter(r => r.status === 'rejected').length,
            byPlan: Array.from(this.plans.keys()).reduce((acc, planId) => {
                acc[planId] = all.filter(r => r.plan === planId).length;
                return acc;
            }, {} as Record<string, number>)
        };
    }

    // Get recent registrations
    public getRecentRegistrations(limit: number = 10): RegistrationData[] {
        return Array.from(this.registrations.values())
            .sort((a, b) => b.timestamp - a.timestamp)
            .slice(0, limit);
    }

    // Search registrations
    public searchRegistrations(query: string): RegistrationData[] {
        const lowerQuery = query.toLowerCase();
        return Array.from(this.registrations.values()).filter(r => 
            r.clientName.toLowerCase().includes(lowerQuery) ||
            r.clientEmail.toLowerCase().includes(lowerQuery) ||
            r.clientPhone.includes(query) ||
            r.clientJid.includes(query)
        );
    }
}

//  Exportar instncia singleton para garantir que todo o app use a mesma instncia
export const registrationHandlerInstance = new RegistrationHandler();


