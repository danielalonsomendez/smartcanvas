import { Component, input, output } from '@angular/core';

@Component({
  selector: 'app-preview-panel',
  standalone: true,
  imports: [],
  templateUrl: './preview-panel.component.html',
})
export class PreviewPanelComponent {
  imageSrc = input.required<string>();
  fileName = input.required<string>();
  fileSize = input.required<string>();
  dimensions = input<{ width: number; height: number } | null>(null);

  clear = output<void>();

  protected onClear(): void {
    this.clear.emit();
  }
}
