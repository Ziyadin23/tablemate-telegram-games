export {};
declare global {
  interface Window {
    Telegram?: { WebApp: {
      initData: string; initDataUnsafe?: { start_param?: string }; colorScheme: 'light' | 'dark';
      themeParams: Record<string, string>; ready(): void; expand(): void;
      onEvent(event: string, callback: () => void): void; offEvent(event: string, callback: () => void): void;
      switchInlineQuery(query: string, chats?: string[]): void; openTelegramLink(url: string): void;
      HapticFeedback?: { impactOccurred(style: string): void };
      BackButton?: { show(): void; hide(): void; onClick(callback: () => void): void; offClick(callback: () => void): void };
    } };
  }
}
