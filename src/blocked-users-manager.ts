import * as fs from 'fs';
import * as path from 'path';

interface BlockedUser {
  jid: string;
  name?: string;
  blockedAt: number;
  reason?: string;
}

export class BlockedUsersManager {
  private blockedUsers: Map<string, BlockedUser> = new Map();
  private filePath: string;

  constructor(configDir: string = path.join(__dirname, '../config')) {
    this.filePath = path.join(configDir, 'blocked-users.json');
    this.ensureDirectoryExists();
    this.loadBlockedUsers();
  }

  private ensureDirectoryExists() {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`📁 Diretório criado: ${dir}`);
      }
    } catch (error) {
      console.error('Erro ao criar diretório:', error);
    }
  }

  private loadBlockedUsers() {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = fs.readFileSync(this.filePath, 'utf-8');
        const users = JSON.parse(data) as BlockedUser[];
        users.forEach(user => {
          this.blockedUsers.set(user.jid, user);
        });
        console.log(`✓ Carregados ${users.length} usuários bloqueados`);
      } else {
        console.log(`✓ Arquivo de bloqueados será criado em: ${this.filePath}`);
        // Criar arquivo vazio na primeira execução
        this.saveBlockedUsers();
      }
    } catch (error) {
      console.error('Erro ao carregar usuários bloqueados:', error);
    }
  }

  private saveBlockedUsers() {
    try {
      const configDir = path.dirname(this.filePath);
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }
      const data = Array.from(this.blockedUsers.values());
      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
    } catch (error) {
      console.error('Erro ao salvar usuários bloqueados:', error);
    }
  }

  blockUser(jid: string, name?: string, reason?: string): boolean {
    if (this.blockedUsers.has(jid)) {
      return false;
    }
    
    this.blockedUsers.set(jid, {
      jid,
      name,
      blockedAt: Date.now(),
      reason
    });
    
    this.saveBlockedUsers();
    return true;
  }

  unblockUser(jid: string): boolean {
    const removed = this.blockedUsers.delete(jid);
    if (removed) {
      this.saveBlockedUsers();
    }
    return removed;
  }

  isBlocked(jid: string): boolean {
    return this.blockedUsers.has(jid);
  }

  getBlockedUsers(): BlockedUser[] {
    return Array.from(this.blockedUsers.values()).sort((a, b) => b.blockedAt - a.blockedAt);
  }

  getBlockedUser(jid: string): BlockedUser | undefined {
    return this.blockedUsers.get(jid);
  }

  clearAll(): void {
    this.blockedUsers.clear();
    this.saveBlockedUsers();
  }
}
