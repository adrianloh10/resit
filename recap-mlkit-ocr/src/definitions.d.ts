export interface RecapMlkitFrame {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface RecapMlkitElement {
  text: string;
  frame: RecapMlkitFrame;
}

export interface RecapMlkitLine {
  text: string;
  frame: RecapMlkitFrame;
  /** ML Kit line confidence in [0,1]; omitted when ML Kit reports none. */
  confidence?: number;
  /** Word-level boxes, used by the JS digit-sniper to crop the amount. */
  elements: RecapMlkitElement[];
}

export interface RecapMlkitResult {
  /** Source image dimensions in pixels — used to map frames into canvas space. */
  width: number;
  height: number;
  lines: RecapMlkitLine[];
}

export interface RecapMlkitOcrPlugin {
  /**
   * Recognise text in a receipt photo on-device via Google ML Kit
   * Text Recognition v2 (Latin).
   *
   * @param options.image Base64-encoded image bytes (optionally a data URL).
   */
  recognize(options: { image: string }): Promise<RecapMlkitResult>;
}
