import * as fs from 'fs';
import * as path from 'path';

type BotChangeAction = 'enable' | 'disable';

interface BotChangeLogEntry {
  timestamp: number;
  action: BotChangeAction;
  changedBy: string;
}

interface BotStatusFile {
  botEnabled: boolean;
  lastStatusChange: number;
  changeLog: BotChangeLogEntry[];
  savedAt?: string;
}

interface BotHistoryResponseEntry extends BotChangeLogEntry {
  status: 'enabled' | 'disabled';
  admin: string;
  formatted: string;
}

export class BotStatus {
  private statusFile: string;
  private botEnabled = true;
  private lastStatusChange = Date.now();
  private changeLog: BotChangeLogEntry[] = [];
  private maxLogEntries = 100;

  constructor() {
    this.statusFile = path.join(__dirname, '../data/bot-status.json');
    this.ensureDataDir();
    this.loadStatus();
  }

  private ensureDataDir() {
    const dataDir = path.dirname(this.statusFile);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
  }

  private loadStatus() {
    try {
      if (fs.existsSync(this.statusFile)) {
        const data = fs.readFileSync(this.statusFile, 'utf-8');
        const config = JSON.parse(data) as Partial<BotStatusFile>;
        this.botEnabled = config.botEnabled ?? true;
        this.lastStatusChange = config.lastStatusChange ?? Date.now();
        this.changeLog = Array.isArray(config.changeLog) ? config.changeLog : [];
      }

      console.log(`Bot Status carregado: ${this.botEnabled ? 'ATIVADO' : 'DESATIVADO'}`);
    } catch (error) {
      console.error('Erro ao carregar status do bot:', error);
      this.botEnabled = true;
      this.lastStatusChange = Date.now();
      this.changeLog = [];
    }
  }

  private saveStatus() {
    try {
      this.ensureDataDir();
      const data: BotStatusFile = {
        botEnabled: this.botEnabled,
        lastStatusChange: this.lastStatusChange,
        changeLog: this.changeLog,
        savedAt: new Date().toISOString()
      };
      fs.writeFileSync(this.statusFile, JSON.stringify(data, null, 2));
    } catch (error) {
      console.error('Erro ao salvar status do bot:', error);
    }
  }

  private formatLogEntry(log: BotChangeLogEntry): BotHistoryResponseEntry {
    return {
      ...log,
      status: log.action === 'enable' ? 'enabled' : 'disabled',
      admin: log.changedBy,
      formatted: `${new Date(log.timestamp).toLocaleString('pt-BR')} - ${log.action === 'enable' ? 'ATIVADO' : 'DESATIVADO'} por ${log.changedBy}`
    };
  }

  private addChangeLog(action: BotChangeAction, changedBy: string) {
    this.changeLog.push({
      timestamp: Date.now(),
      action,
      changedBy
    });

    if (this.changeLog.length > this.maxLogEntries) {
      this.changeLog = this.changeLog.slice(-this.maxLogEntries);
    }
  }

  public enableBot(changedBy: string = 'admin'): boolean {
    if (this.botEnabled) {
      return false;
    }

    this.botEnabled = true;
    this.lastStatusChange = Date.now();
    this.addChangeLog('enable', changedBy);
    this.saveStatus();

    console.log(`BOT ATIVADO por ${changedBy}`);
    return true;
  }

  public disableBot(changedBy: string = 'admin'): boolean {
    if (!this.botEnabled) {
      return false;
    }

    this.botEnabled = false;
    this.lastStatusChange = Date.now();
    this.addChangeLog('disable', changedBy);
    this.saveStatus();

    console.log(`BOT DESATIVADO por ${changedBy}`);
    return true;
  }

  public toggleBot(changedBy: string = 'admin'): boolean {
    return this.botEnabled ? this.disableBot(changedBy) : this.enableBot(changedBy);
  }

  public isEnabled(): boolean {
    return this.botEnabled;
  }

  public getStatus(): {
    enabled: boolean;
    lastStatusChange: number;
    lastStatusChangeFormatted: string;
    changeLog: BotHistoryResponseEntry[];
  } {
    return {
      enabled: this.botEnabled,
      lastStatusChange: this.lastStatusChange,
      lastStatusChangeFormatted: new Date(this.lastStatusChange).toLocaleString('pt-BR'),
      changeLog: this.changeLog.map(log => this.formatLogEntry(log))
    };
  }

  public getChangeHistory(limit: number = 50): BotHistoryResponseEntry[] {
    return this.changeLog
      .slice(-limit)
      .map(log => this.formatLogEntry(log));
  }

  public clearChangeHistory() {
    this.changeLog = [];
    this.saveStatus();
  }
}

export const botStatus = new BotStatus();
