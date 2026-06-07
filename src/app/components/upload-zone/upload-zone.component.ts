import { Component, output, signal } from '@angular/core';

@Component({
  selector: 'app-upload-zone',
  standalone: true,
  imports: [],
  templateUrl: './upload-zone.component.html',
})
export class UploadZoneComponent {
  fileSelected = output<File>();
  
  protected readonly isDragging = signal<boolean>(false);

  protected onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      this.fileSelected.emit(input.files[0]);
    }
  }

  protected onDragOver(event: DragEvent): void {
    event.preventDefault();
    this.isDragging.set(true);
  }

  protected onDragLeave(event: DragEvent): void {
    event.preventDefault();
    this.isDragging.set(false);
  }

  protected onDrop(event: DragEvent): void {
    event.preventDefault();
    this.isDragging.set(false);
    if (event.dataTransfer && event.dataTransfer.files.length > 0) {
      this.fileSelected.emit(event.dataTransfer.files[0]);
    }
  }
}
