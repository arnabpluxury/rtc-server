export const rtcServerConfig = {
  httpPort: 3002,
  publicBaseUrl: 'https://rtc.synerstudio.net.in',
  jwt: {
    tokenSecret: '9d20f4f0d8b94b13b3246e0edb2f2f17e5f0d2f*********************',
    issuer: 'https://panels.synerstudio.net.in',
    audience: 'https://rtc.synerstudio.net.in',
  },
  mediasoup: {
    announcedIp: '203.57.85.182',
    rtcMinPort: 40000,
    rtcMaxPort: 49999,
  },
} as const
