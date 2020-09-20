import { Entity, PrimaryGeneratedColumn, Column, Generated, BaseEntity } from 'typeorm';
import { Database } from '../clients/database';
import { v4 as uuidv4 } from 'uuid';

export type UserClass = 'user' | 'admin';
// Used when combining accounts to determine and keep the 'higher ranked' user class
const userClassRank: UserClass[] = ['user', 'admin'];
function pickHigherUserClass(userClass1: UserClass, userClass2: UserClass) {
  if (userClassRank.indexOf(userClass1) > userClassRank.indexOf(userClass2)) return userClass1;
  return userClass2;
}

@Entity()
export class User extends BaseEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  @Generated('uuid') // if not defined, random useless uuid is used (for uniqueness)
  twitchUserId: string;

  @Column({ unique: true })
  @Generated('uuid') // if not defined, random useless uuid is used (for uniqueness)
  discordUserId: string;

  @Column({ unique: true })
  @Generated('uuid')
  apiKey: string;

  @Column({ default: 'user' })
  userClass: UserClass;

  @Column({ nullable: true })
  linkToken?: string;

  public isAdmin() {
    return this.userClass === 'admin';
  }

  public async getNewApiKey() {
    this.apiKey = uuidv4();
    await this.save();
    return this.apiKey;
  }

  public async generateNewLinkToken(usernameToLink: string) {
    const randomToken = uuidv4();
    this.linkToken = `${usernameToLink} ${randomToken}`;
    await this.save();
    return randomToken;
  }

  public static async findByDiscordId(discordId: string) {
    return User.findOne({ where: { discordUserId: discordId } });
  }

  public static async findByTwitchUserId(twitchUserId: string) {
    return User.findOne({ where: { twitchUserId } });
  }

  public static async findByLinkToken(username: string, randomToken: string) {
    return User.findOne({ where: { linkToken: `${username} ${randomToken}` } });
  }

  public static async linkAccounts(twitchUser: User, discordUser: User) {
    const combinedUser = new User();
    combinedUser.twitchUserId = twitchUser.twitchUserId;
    combinedUser.discordUserId = discordUser.discordUserId;
    // Combine any other properties (i.e. owned chips) here
    combinedUser.userClass = pickHigherUserClass(twitchUser.userClass, discordUser.userClass);
    // Delete the old users and save the new combined one
    await Database.connection.transaction(async (transactionManager) => {
      await transactionManager.delete(User, [twitchUser.id, discordUser.id]);
      await transactionManager.save(combinedUser);
    });
    return combinedUser;
  }
}
