import { AccessTokenPayload } from '../utils/jwt';

declare global {
  namespace Express {
    // Passport also augments Request.user (as Express.User); extend that
    // interface instead of redeclaring Request.user, so both typings merge.
    interface User extends AccessTokenPayload {}
  }
}

export {};
