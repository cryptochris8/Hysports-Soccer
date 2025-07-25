import { Audio, Entity, Player, PlayerCameraMode, PlayerEntity, World, EntityEvent, type Vector3Like } from "hytopia";
import CustomSoccerPlayer from "../controllers/SoccerPlayerController";
import sharedState from "../state/sharedState";
import { getDirectionFromRotation } from "../utils/direction";
import { 
  STUN_DURATION, 
  TACKLE_KNOCKBACK_FORCE,
  AI_GOAL_LINE_X_RED,
  AI_GOAL_LINE_X_BLUE,
  AI_FIELD_CENTER_Z,
  AI_DEFENSIVE_OFFSET_X,
  AI_MIDFIELD_OFFSET_X,
  AI_FORWARD_OFFSET_X,
  AI_WIDE_Z_BOUNDARY_MAX,
  AI_WIDE_Z_BOUNDARY_MIN,
  AI_MIDFIELD_Z_BOUNDARY_MAX,
  AI_MIDFIELD_Z_BOUNDARY_MIN,
  SAFE_SPAWN_Y
} from "../state/gameConfig";
import { AbilityHolder } from "../abilities/AbilityHolder";

// Define type for Node.js timer
type Timer = ReturnType<typeof setTimeout>;

// Define SoccerAIRole locally
export type SoccerAIRole = 
  'goalkeeper' | 
  'left-back' | 
  'right-back' | 
  'central-midfielder-1' | 
  'central-midfielder-2' | 
  'striker';

export default class SoccerPlayerEntity extends PlayerEntity {
  private _isStunned: boolean = false;
  private _isTackling: boolean = false;
  private _isDodging: boolean = false;
  private _stunTimeout?: Timer;
  private _team: "red" | "blue";
  public isPlayerFrozen: boolean = false; // Changed to public for access from outside
  private playerId: string;
  private goalsScored: number = 0;
  // Enhanced statistics tracking
  private tacklesMade: number = 0;
  private passesMade: number = 0;
  private shotsTaken: number = 0;
  private savesMade: number = 0;
  private distanceTraveled: number = 0;
  private lastPosition: Vector3Like | null = null;
  private speedAmplifier: number = 0;
  public abilityHolder: AbilityHolder;
  public role: SoccerAIRole; // Added role property

  public constructor(player: Player, team: "red" | "blue", role: SoccerAIRole) {
    super({
      player,
      name: "Player",
      modelUri: `models/players/player-${team}.gltf`,
      modelLoopedAnimations: ["idle"],
      modelScale: 0.5,
    });
    this._team = team;
    this.role = role; // Assign role
    // create random id for player
    this.playerId = Math.random().toString(36).substring(2, 15);
    this.setController(
      new CustomSoccerPlayer({
        canJump: () => true,
        canWalk: () => true,
        canRun: () => true,
        runVelocity: 5.5,
        walkVelocity: 3.5,
      })
    );
    
    // Don't set camera properties immediately, only on EntityEvent.SPAWN
    // This ensures the entity is fully registered before attaching the camera
    this.on(EntityEvent.SPAWN, () => {
      console.log(`Entity spawn event for ${player.username} (entity ${this.id})`);
      
      // Set team-appropriate rotation after spawn
      if (this.team === "blue") {
        this.setRotation({ x: 0, y: 1, z: 0, w: 0 }); // Blue faces -X
      } else {
        this.setRotation({ x: 0, y: 0, z: 0, w: 1 }); // Red faces +X
      }
      
      // For real players (not AI), handle camera attachment and state registration
      const isRealPlayer = player && player.camera && typeof player.camera.setAttachedToEntity === 'function';
      if (isRealPlayer) {
        try {
          // Simple camera attachment
          player.camera.setAttachedToEntity(this);
          console.log(`Camera attached to entity ${this.id} for player ${player.username}`);
          
          // Only set active player for human players - important for camera attachment
          sharedState.setActivePlayer(this);
          console.log(`Set active player in shared state: ${player.username}`);
        } catch (e) {
          console.error(`Error attaching camera for player ${player.username}:`, e);
        }
      }
      
      console.log(`Entity ${this.id} (${player.username}) spawned as ${team} ${role}`);
      
      // Check and correct position after spawn
      const currentPos = this.position;
      const expectedY = SAFE_SPAWN_Y;
      
      if (Math.abs(currentPos.y - expectedY) > 1) {
        console.log(`Correcting Y position from ${currentPos.y} to ${expectedY} for ${player.username}`);
        this.setPosition({ x: currentPos.x, y: expectedY, z: currentPos.z });
        this.wakeUp(); // Wake up physics after position correction
      }
    });
    
    this.on(EntityEvent.ENTITY_COLLISION, ({ entity, otherEntity, started }) => {
      if (!started || !(otherEntity instanceof SoccerPlayerEntity)) return;
      this.onEntityCollisionHandler(entity, otherEntity, started);
    });
    
    // Safely create ability holder for real players
    try {
      this.abilityHolder = new AbilityHolder(player);
    } catch (e) {
      console.log("Could not create ability holder for player", e);
      // Create a minimal ability holder for AI players
      this.abilityHolder = {
        getAbility: () => null,
        setAbility: () => {},
        useAbility: () => false,
        clearAbility: () => {}
      } as any;
    }
  }

  public get team(): "red" | "blue" {
    return this._team;
  }

  public stunPlayerTimeout() {
    this.isStunned = true;
    if (this._stunTimeout) {
      clearTimeout(this._stunTimeout);
    }
    this._stunTimeout = setTimeout(() => {
      this.isStunned = false;
    }, STUN_DURATION);
  }

  public get isStunned(): boolean {
    return this._isStunned;
  }

  public get isTackling(): boolean {
    return this._isTackling;
  }

  public set isStunned(value: boolean) {
    this._isStunned = value;
  }

  public set isTackling(value: boolean) {
    this._isTackling = value;
  }

  public set isDodging(value: boolean) {
    this._isDodging = value;
  }

  public get isDodging(): boolean {
    return this._isDodging;
  }

  public getPlayerId(): string {
    return this.playerId;
  }

  public moveToSpawnPoint() {
    if (!this.isSpawned) return;

    const spawnPosition = this.getRoleBasedPosition();
    
    // Reset physics state before positioning
    this.setLinearVelocity({ x: 0, y: 0, z: 0 });
    this.setAngularVelocity({ x: 0, y: 0, z: 0 });
    this.setPosition(spawnPosition);
    
    // Set rotation based on team (red faces blue goal (+X), blue faces red goal (-X))
    // Blue team's goal is at positive X, so they should face negative X. Rotation is 180 deg around Y.
    // Red team's goal is at negative X, so they should face positive X. Rotation is 0 deg around Y.
    if (this.team === "blue") {
      this.setRotation({ x: 0, y: 1, z: 0, w: 0 }); // Facing -X
    } else { // Red team
      this.setRotation({ x: 0, y: 0, z: 0, w: 1 }); // Facing +X (default)
    }

    this.wakeUp(); // Ensure physics state is updated after teleport
  }

  public getRoleBasedPosition(): Vector3Like {
    const isRed = this.team === 'red';
    const y = SAFE_SPAWN_Y;
    let x = 0; 
    let z = 0; 

    const ownGoalLineX = isRed ? AI_GOAL_LINE_X_RED : AI_GOAL_LINE_X_BLUE;
    // Red team players are positioned relative to Red's goal line and move towards positive X (Blue's goal).
    // Blue team players are positioned relative to Blue's goal line and move towards negative X (Red's goal).
    const forwardXMultiplier = isRed ? 1 : -1;

    switch (this.role) {
      case 'goalkeeper':
        x = ownGoalLineX + (1 * forwardXMultiplier);
        z = AI_FIELD_CENTER_Z;
        break;
      case 'left-back': 
        x = ownGoalLineX + (AI_DEFENSIVE_OFFSET_X * forwardXMultiplier);
        z = AI_FIELD_CENTER_Z + (AI_WIDE_Z_BOUNDARY_MIN - AI_FIELD_CENTER_Z) * 0.6;
        break;
      case 'right-back': 
        x = ownGoalLineX + (AI_DEFENSIVE_OFFSET_X * forwardXMultiplier);
        z = AI_FIELD_CENTER_Z + (AI_WIDE_Z_BOUNDARY_MAX - AI_FIELD_CENTER_Z) * 0.6;
        break;
      case 'central-midfielder-1':
        x = ownGoalLineX + (AI_MIDFIELD_OFFSET_X * forwardXMultiplier);
        z = AI_FIELD_CENTER_Z + (AI_MIDFIELD_Z_BOUNDARY_MIN - AI_FIELD_CENTER_Z) * 0.5;
        break;
      case 'central-midfielder-2':
        x = ownGoalLineX + (AI_MIDFIELD_OFFSET_X * forwardXMultiplier);
        z = AI_FIELD_CENTER_Z + (AI_MIDFIELD_Z_BOUNDARY_MAX - AI_FIELD_CENTER_Z) * 0.5;
        break;
      case 'striker':
        x = ownGoalLineX + (AI_FORWARD_OFFSET_X * forwardXMultiplier);
        z = AI_FIELD_CENTER_Z;
        break;
      default: 
        // Fallback: if role is somehow unknown, place near center midfield for safety
        console.warn(`SoccerPlayerEntity ${this.player?.username}: Unknown role '${this.role}' in getRoleBasedPosition. Defaulting to midfield.`);
        x = ownGoalLineX + (AI_MIDFIELD_OFFSET_X * forwardXMultiplier);
        z = AI_FIELD_CENTER_Z;
    }
    return { x, y, z };
  }

  private onEntityCollisionHandler(
    entity: Entity,
    otherEntity: SoccerPlayerEntity,
    started: boolean
  ) {
    {
      const player = entity;
      const otherPlayer = otherEntity;

      if (
        !(player instanceof SoccerPlayerEntity) ||
        !(otherPlayer instanceof SoccerPlayerEntity) ||
        player.team === otherPlayer.team
      )
        return; // dont do anything if the players are on the same team

      // If we're tackling and hit another player, stun them unless they're dodging
      if (this.isTackling && !otherEntity.isStunned && !otherEntity.isDodging) {
        otherEntity.stunPlayer();
        this.addTackle(); // Track successful tackle
      }
    }
  }

  public speedBoost(boost: number) {
    this.speedAmplifier = boost;
    setTimeout(() => {
      this.speedAmplifier = 0;
    }, 10 * 1000);
  }

  public getSpeedAmplifier(): number {
    return this.speedAmplifier;
  }

  public stunPlayer() {
    console.log("Stunning player");
        const attachedPlayer = sharedState.getAttachedPlayer();
        const soccerBall = sharedState.getSoccerBall();

        // If the other player has the ball, make them drop it
        if (attachedPlayer?.player.username === this.player.username) {
          sharedState.setAttachedPlayer(null);

          // Apply a small impulse to the ball
          const direction = getDirectionFromRotation(this.rotation);
          soccerBall?.applyImpulse({
            x: direction.x * 1,
            y: 0.5,
            z: direction.z * 1,
          });
          // Reset angular velocity to prevent unwanted spinning/backwards movement
          soccerBall?.setAngularVelocity({ x: 0, y: 0, z: 0 });
        }

        // Stun the other player
        this.stunPlayerTimeout();
        console.log("Starting dizzy animation");
        
        // Large stadium mode - realistic soccer without visual effects
        // No stars or special effects in large stadium mode
        
        this.stopModelAnimations(Array.from(this.modelLoopedAnimations).filter(v => v !== 'dizzy'));
        this.startModelOneshotAnimations(["dizzy"]);

        // Apply knockback to the hit player
        const direction = {
          x: this.position.x - this.position.x,
          z: this.position.z - this.position.z,
        };
        const length = Math.sqrt(
          direction.x * direction.x + direction.z * direction.z
        );
        if (length > 0) {
          const normalized = {
            x: direction.x / length,
            z: direction.z / length,
          };
          this.applyImpulse({
            x: normalized.x * TACKLE_KNOCKBACK_FORCE,
            y: 4,
            z: normalized.z * TACKLE_KNOCKBACK_FORCE,
          });
        }
  }

  public getGoalsScored(): number {
    return this.goalsScored;
  }

  public addGoal() {
    this.goalsScored++;
  }

  // Enhanced statistics methods
  public addTackle() {
    this.tacklesMade++;
  }

  public addPass() {
    this.passesMade++;
  }

  public addShot() {
    this.shotsTaken++;
  }

  public addSave() {
    this.savesMade++;
  }

  public updateDistanceTraveled() {
    if (this.lastPosition) {
      const currentPos = this.position;
      const distance = Math.sqrt(
        Math.pow(currentPos.x - this.lastPosition.x, 2) +
        Math.pow(currentPos.z - this.lastPosition.z, 2)
      );
      this.distanceTraveled += distance;
    }
    this.lastPosition = { ...this.position };
  }

  public getPlayerStats() {
    return {
      name: this.player.username,
      team: this.team,
      role: this.role,
      goals: this.goalsScored,
      tackles: this.tacklesMade,
      passes: this.passesMade,
      shots: this.shotsTaken,
      saves: this.savesMade,
      distanceTraveled: Math.round(this.distanceTraveled * 10) / 10 // Round to 1 decimal place
    };
  }

  public resetStats() {
    this.goalsScored = 0;
    this.tacklesMade = 0;
    this.passesMade = 0;
    this.shotsTaken = 0;
    this.savesMade = 0;
    this.distanceTraveled = 0;
    this.lastPosition = null;
  }

  public freeze() {
    this.isPlayerFrozen = true;
    this.setLinearVelocity({ x: 0, y: 0, z: 0 });
  }

  public unfreeze() {
    this.isPlayerFrozen = false;
    this.wakeUp(); // Ensure physics state is updated after unfreezing
  }
}
