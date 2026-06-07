import { Component, input, output, signal } from '@angular/core';
import { SavedImage } from '../../services/indexed-db.service';
import { UploadZoneComponent } from '../upload-zone/upload-zone.component';
import { ChatPanelComponent } from '../chat-panel/chat-panel.component';
import { CanvasActions } from '../canvas-editor/canvas-editor.component';

@Component({
  selector: 'app-history-sidebar',
  standalone: true,
  imports: [UploadZoneComponent, ChatPanelComponent],
  templateUrl: './history-sidebar.component.html',
})
export class HistorySidebarComponent {
  images = input.required<SavedImage[]>();
  selectedId = input<number | null>(null);
  
  // Layer details & photo-selected state properties
  layers = input<any[]>([]);
  activeImageName = input<string | null>(null);
  imageSrc = input<string | null>(null);

  // Agent canvas actions bridge
  canvasActions = input<CanvasActions | null>(null);
  imageMetadata = input<{ name: string; width: number; height: number; size: string } | null>(null);

  selectImage = output<SavedImage>();
  deleteImage = output<number>();
  fileSelected = output<File>();

  // Layer events propagated back to parent canvas page
  selectLayer = output<any>();
  toggleLayerVisibility = output<any>();
  deleteLayer = output<any>();
  backToList = output<void>();

  protected readonly activeTab = signal<'layers' | 'chat'>('layers');

  protected onSelect(image: SavedImage): void {
    this.selectImage.emit(image);
  }

  protected onDelete(event: Event, id: number): void {
    event.stopPropagation();
    this.deleteImage.emit(id);
  }

  protected onFileSelected(file: File): void {
    this.fileSelected.emit(file);
  }

  protected setActiveTab(tab: 'layers' | 'chat'): void {
    this.activeTab.set(tab);
  }

  protected goBackToList(): void {
    this.backToList.emit();
  }

  protected onSelectLayer(layer: any): void {
    this.selectLayer.emit(layer);
  }

  protected onToggleLayerVisibility(event: Event, layer: any): void {
    this.toggleLayerVisibility.emit({ event, layer });
  }

  protected onDeleteLayer(event: Event, layer: any): void {
    this.deleteLayer.emit({ event, layer });
  }

  protected getRelativeTime(timestamp: number): string {
    const diff = Date.now() - timestamp;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(minutes / 60);

    if (minutes < 1) {
      return 'just now';
    } else if (minutes < 60) {
      return `${minutes}m ago`;
    } else if (hours < 24) {
      return `${hours}h ago`;
    } else {
      const date = new Date(timestamp);
      return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }
  }
}
