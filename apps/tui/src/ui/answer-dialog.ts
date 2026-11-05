import {
  Container,
  Input,
  Text,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";

/** Overlay container that forwards keyboard input and IME focus to its Input. */
export class AnswerDialog extends Container implements Focusable {
  readonly input = new Input({ prompt: "answer: " });
  private focusedFlag = false;

  constructor(title: string, question: string) {
    super();
    this.addChild(new Text(`${title}\n${question}`, 0, 0));
    this.addChild(this.input);
    this.addChild(new Text("Enter submit \u00b7 Esc cancel", 0, 0));
  }

  get focused(): boolean {
    return this.focusedFlag;
  }

  set focused(value: boolean) {
    this.focusedFlag = value;
    this.input.focused = value;
  }

  handleInput(data: string): void {
    this.input.handleInput(data);
  }

  invalidate(): void {
    super.invalidate();
  }
}
