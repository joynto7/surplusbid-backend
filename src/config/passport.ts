import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { env } from './env';
import { prisma } from './prisma';

passport.use(
  new GoogleStrategy(
    {
      clientID: env.google.clientId,
      clientSecret: env.google.clientSecret,
      callbackURL: env.google.callbackUrl,
    },
    async (_accessToken, _refreshToken, profile, done) => {
      const email = profile.emails?.[0]?.value;
      if (!email) return done(new Error('Google account has no email'));

      let user = await prisma.user.findFirst({ where: { email, deletedAt: null } });
      if (!user) {
        user = await prisma.user.create({
          data: {
            email,
            authProvider: 'GOOGLE',
            googleId: profile.id,
            role: 'BUYER',
            companyName: profile.displayName || email,
          },
        });
      }
      return done(null, user);
    }
  )
);

export default passport;
