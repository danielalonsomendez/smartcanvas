import { Component, computed, effect, ElementRef, inject, input, signal, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CopilotService } from '../../services/copilot.service';
import { CanvasActions } from '../canvas-editor/canvas-editor.component';

@Component({
  selector: 'app-chat-panel',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './chat-panel.component.html',
})
export class ChatPanelComponent {
  protected readonly copilotService = inject(CopilotService);

  // Inputs received from the parent canvas component / sidebar
  imageId = input<number | null>(null);
  activeImage = input<string | null>(null);
  layers = input<any[]>([]);
  imageSrc = input<string | null>(null);

  // Agent canvas actions bridge
  canvasActions = input<CanvasActions | null>(null);
  imageMetadata = input<{ name: string; width: number; height: number; size: string } | null>(null);

  @ViewChild('chatScrollContainer') private scrollContainer?: ElementRef;

  // UI state signals
  protected readonly tokenInput = signal<string>('');
  protected readonly messageInput = signal<string>('');
  protected readonly errorMessage = signal<string | null>(null);
  protected readonly isLoggingIn = signal<boolean>(false);

  /** Models grouped by publisher for <optgroup> rendering */
  protected readonly modelsByPublisher = computed(() => {
    const groups = new Map<string, { id: string; name: string; publisher: string }[]>();
    for (const m of this.copilotService.models()) {
      const pub = m.publisher ?? 'Other';
      if (!groups.has(pub)) groups.set(pub, []);
      groups.get(pub)!.push(m);
    }
    return Array.from(groups.entries()).map(([publisher, models]) => ({ publisher, models }));
  });

  constructor() {
    // Automatically load chat history when the active image changes
    effect(() => {
      const id = this.imageId();
      if (id !== null) {
        this.errorMessage.set(null);
        this.copilotService.loadHistory(id).then(() => {
          this.scrollToBottom();
        });
      }
    });

    // Auto-scroll when new messages arrive
    effect(() => {
      // Access messages signal to register dependency
      const count = this.copilotService.messages().length;
      if (count > 0) {
        // Run after view updates
        setTimeout(() => this.scrollToBottom(), 50);
      }
    });
  }

  protected async onLogin(): Promise<void> {
    const token = this.tokenInput().trim();
    if (!token) {
      this.errorMessage.set('Please enter a valid GitHub token.');
      return;
    }

    this.isLoggingIn.set(true);
    this.errorMessage.set(null);

    try {
      await this.copilotService.login(token);
      this.tokenInput.set('');
      const id = this.imageId();
      if (id !== null) {
        await this.copilotService.loadHistory(id);
      }
    } catch (err: any) {
      this.errorMessage.set(err.message || 'Failed to authenticate with GitHub.');
    } finally {
      this.isLoggingIn.set(false);
    }
  }

  protected onLogout(): void {
    this.copilotService.logout();
    this.errorMessage.set(null);
  }

  protected async onSendMessage(): Promise<void> {
    const text = this.messageInput().trim();
    const id = this.imageId();
    
    if (!text || id === null || this.copilotService.isThinking()) {
      return;
    }

    this.messageInput.set('');
    this.errorMessage.set(null);

    try {
      await this.copilotService.sendMessage(
        id,
        text,
        this.imageSrc(),
        this.layers(),
        () => {
          this.scrollToBottom();
        },
        this.canvasActions(),
        this.imageMetadata()
      );
    } catch (err: any) {
      this.errorMessage.set(err.message || 'Failed to send message.');
    }
  }

  protected onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.onSendMessage();
    }
  }

  protected onSelectSuggestion(text: string): void {
    this.messageInput.set(text);
    this.onSendMessage();
  }

  protected async onClearChat(): Promise<void> {
    const id = this.imageId();
    if (id !== null) {
      if (confirm('Are you sure you want to clear the conversation history for this photo?')) {
        await this.copilotService.clearChat(id);
      }
    }
  }

  protected getParsedArgs(argsString: string): any {
    try {
      return JSON.parse(argsString);
    } catch {
      return argsString;
    }
  }

  protected getKeys(obj: any): string[] {
    if (typeof obj !== 'object' || obj === null) return [];
    return Object.keys(obj);
  }

  private scrollToBottom(): void {
    if (this.scrollContainer) {
      const element = this.scrollContainer.nativeElement;
      element.scrollTop = element.scrollHeight;
    }
  }
}
