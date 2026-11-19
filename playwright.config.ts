import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  testMatch: /.*\.spec\.ts$/,
  timeout: 150_000,
  expect: { timeout: 20_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  globalSetup: './e2e/global-setup.ts',
  use: {
    browserName: 'chromium',
    headless: true,
    screenshot: 'only-on-failure',
    // H.264/AAC playback needs a Chromium build with proprietary codecs (distro/snap builds have them).
    launchOptions: {
      executablePath: process.env.WATCHROOM_CHROMIUM ?? '/snap/bin/chromium',
      // Real local addresses in WebRTC candidates (instead of .local mDNS names), so direct connections between test
      // browsers and the test host work without multicast DNS.
      args: ['--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'],
    },
  },
});
