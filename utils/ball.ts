import {
  BlockType,
  ColliderShape,
  Entity,
  RigidBodyType,
  World,
  Audio,
  EntityEvent,
} from "hytopia";
import sharedState from "../state/sharedState";
import { getDirectionFromRotation } from "./direction";
import { BALL_CONFIG, BALL_SPAWN_POSITION, FIELD_MIN_Y } from "../state/gameConfig";
import { soccerMap } from "../state/map";
import type { BoundaryInfo } from "../state/map";
import SoccerPlayerEntity from "../entities/SoccerPlayerEntity";

export default function createSoccerBall(world: World) {
  console.log("Creating soccer ball with config:", JSON.stringify(BALL_CONFIG));
  console.log("Ball spawn position:", JSON.stringify(BALL_SPAWN_POSITION));
  
  const soccerBall = new Entity({
    name: "SoccerBall",
    modelUri: "models/soccer/scene.gltf",
    modelScale: BALL_CONFIG.SCALE,
    rigidBodyOptions: {
      type: RigidBodyType.DYNAMIC,
      ccdEnabled: true, // Continuous collision detection to prevent tunneling
      linearDamping: BALL_CONFIG.LINEAR_DAMPING,
      angularDamping: BALL_CONFIG.ANGULAR_DAMPING,
      colliders: [
        {
          shape: ColliderShape.BALL,
          radius: BALL_CONFIG.RADIUS,
          friction: BALL_CONFIG.FRICTION,
          // Ensure proper collision groups for terrain interaction
          collisionGroups: {
            belongsTo: [1], // Default collision group
            collidesWith: [1, 2, 4] // Collide with terrain, blocks, and entities
          }
        },
      ],
    },
  });

  sharedState.setSoccerBall(soccerBall);

  let inGoal = false;
  let isRespawning = false;
  let lastPosition = { ...BALL_SPAWN_POSITION };
  let ticksSinceLastPositionCheck = 0;
  let isInitializing = true; // Flag to prevent whistle during startup
  let whistleDebounceTimer = 0; // Add a timer to prevent multiple whistles

  console.log("Ball entity created, spawning at proper ground position");
  
  // Only spawn the ball if it's not already spawned
  if (!soccerBall.isSpawned) {
    // Simple spawn at the correct position (now with guaranteed ground block)
    soccerBall.spawn(world, BALL_SPAWN_POSITION);
    // Reset physics state
    soccerBall.setLinearVelocity({ x: 0, y: 0, z: 0 });
    soccerBall.setAngularVelocity({ x: 0, y: 0, z: 0 });
    // Force physics update
    soccerBall.wakeUp();
    
    console.log("Ball spawned successfully at:", JSON.stringify(BALL_SPAWN_POSITION));
    console.log("Ball spawn status:", soccerBall.isSpawned ? "SUCCESS" : "FAILED");
  } else {
    console.log("Ball is already spawned, skipping spawn");
  }
  
  // Short delay to complete initialization and enable boundary checks
  setTimeout(() => {
    isInitializing = false;
    console.log("Ball initialization complete, enabling boundary checks");
    console.log("Current ball position:", 
      soccerBall.isSpawned ? 
      `x=${soccerBall.position.x}, y=${soccerBall.position.y}, z=${soccerBall.position.z}` : 
      "Ball not spawned");
  }, 1000); // 1 second delay is sufficient

  soccerBall.on(EntityEvent.TICK, ({ entity, tickDeltaMs }) => {
    // Check if ball has moved from spawn
    if (!sharedState.getBallHasMoved()) {
      const currentPos = { ...entity.position }; // Clone position
      const spawnPos = BALL_SPAWN_POSITION;
      const dx = currentPos.x - spawnPos.x;
      const dy = currentPos.y - spawnPos.y;
      const dz = currentPos.z - spawnPos.z;
      // Use a small threshold to account for minor physics jitter
      const distanceMoved = Math.sqrt(dx*dx + dy*dy + dz*dz);
      if (distanceMoved > 0.1) {
        sharedState.setBallHasMoved();
        
        // Check if this is a penalty shootout and trigger penalty shot
        const gameStatus = sharedState.getGameStatus();
        if (gameStatus === "penalty-shootout") {
          console.log("🥅 Ball moved during penalty shootout - triggering penalty shot");
          world.emit("penalty-shot-taken" as any, {} as any);
        }
      }
    }

    // Check for sudden large position changes that could cause camera shaking
    ticksSinceLastPositionCheck++;
    if (ticksSinceLastPositionCheck >= 5) { // Check every 5 ticks
      ticksSinceLastPositionCheck = 0;
      const currentPos = { ...entity.position };
      const dx = currentPos.x - lastPosition.x;
      const dy = currentPos.y - lastPosition.y;
      const dz = currentPos.z - lastPosition.z;
      const positionChange = Math.sqrt(dx*dx + dy*dy + dz*dz);
      
      // Use more subtle position correction only for extreme cases
      if (positionChange > 5.0) {
        entity.setPosition({
          x: lastPosition.x + dx * 0.7,
          y: lastPosition.y + dy * 0.7,
          z: lastPosition.z + dz * 0.7
        });
      }
      
      lastPosition = { ...entity.position };
    }
    
    const attachedPlayer = sharedState.getAttachedPlayer();

    // If the ball falls significantly below the field (should be rare now), reset it
    if (entity.position.y < FIELD_MIN_Y - 3 && !isRespawning && !inGoal && !isInitializing) {
      console.log(`Ball unexpectedly below field at Y=${entity.position.y}, resetting to spawn position`);
      isRespawning = true;
      
      // Reset the ball position without playing the whistle (this is a physics issue, not gameplay)
      entity.despawn();
      sharedState.setAttachedPlayer(null);
      
      // Spawn at the proper ground position
      entity.spawn(world, BALL_SPAWN_POSITION);
      entity.setLinearVelocity({ x: 0, y: 0, z: 0 });
      entity.setAngularVelocity({ x: 0, y: 0, z: 0 });
      
      // Reset respawning flag after a delay
      setTimeout(() => {
        isRespawning = false;
      }, 1000);
      
      return; // Skip the rest of the checks
    }

    // Skip all goal and boundary checks during initialization or if already handling an event
    if (attachedPlayer == null && !inGoal && !isRespawning && !isInitializing) {
      const currentPos = { ...entity.position }; // Clone position
      
      // Skip boundary check if the ball is clearly below the field
      if (currentPos.y < FIELD_MIN_Y - 1) {
        return;
      }
      
      // Enhanced goal detection - check for goals
      const goal = soccerMap.checkGoal(currentPos);
      if (goal) {
        console.log(`GOAL DETECTED by ball at position ${currentPos.x}, ${currentPos.y}, ${currentPos.z} for team ${goal.team}`);
        inGoal = true;
        // Add a small delay before emitting the goal event to ensure it's not a glancing blow
        setTimeout(() => {
          // Double-check we're still in the goal and not already being handled
          const updatedPos = { ...entity.position };
          const stillInGoal = soccerMap.checkGoal(updatedPos);
          if (stillInGoal && stillInGoal.team === goal.team && inGoal) {
            console.log(`Confirming GOAL event for team ${goal.team}`);
            // Emit the goal event without playing the whistle here
            // The whistle will be played by the game state handler
            world.emit("goal" as any, goal.team as any);
            
            // Reset ball position after a delay
            setTimeout(() => {
              if (inGoal) { // Double check we're still handling this goal
                entity.despawn();
                entity.spawn(world, BALL_SPAWN_POSITION);
                entity.setLinearVelocity({ x: 0, y: 0, z: 0 });
                entity.setAngularVelocity({ x: 0, y: 0, z: 0 });
                inGoal = false;
              }
            }, 3000);
          } else {
            // Ball moved out of goal during confirmation delay
            inGoal = false;
          }
        }, 100); // Short confirmation delay
      }
      // Enhanced out-of-bounds detection with detailed boundary information
      else {
        const boundaryInfo: BoundaryInfo = soccerMap.checkBoundaryDetails(currentPos);
        
        if (boundaryInfo.isOutOfBounds && !isRespawning) {
          console.log(`Ball out of bounds:`, boundaryInfo);
          
          // Check if a whistle was recently played
          const currentTime = Date.now();
          if (currentTime - whistleDebounceTimer < 3000) {
            // Skip playing the whistle if one was played less than 3 seconds ago
            console.log("Skipping whistle sound (debounced)");
          } else {
            console.log(`Ball out of bounds at position ${currentPos.x}, ${currentPos.y}, ${currentPos.z} - playing whistle`);
            whistleDebounceTimer = currentTime;
            
            // Play a single whistle for out of bounds
            new Audio({
              uri: "audio/sfx/soccer/whistle.mp3",
              volume: 0.1,
              loop: false
            }).play(world);
          }
          
          isRespawning = true;
          
          setTimeout(() => {
            if (isRespawning) { // Make sure we're still handling this out-of-bounds event
              // Reset the ball position
              entity.despawn();
              sharedState.setAttachedPlayer(null);
              
              // Emit different events based on boundary type
              if (boundaryInfo.boundaryType === 'sideline') {
                // Ball went out on sideline - throw-in
                console.log("Emitting throw-in event");
                world.emit("ball-out-sideline" as any, {
                  side: boundaryInfo.side,
                  position: boundaryInfo.position,
                  lastPlayer: sharedState.getLastPlayerWithBall()
                } as any);
              } else if (boundaryInfo.boundaryType === 'goal-line') {
                // Ball went out over goal line - corner kick or goal kick
                console.log("Emitting goal-line out event");
                world.emit("ball-out-goal-line" as any, {
                  side: boundaryInfo.side,
                  position: boundaryInfo.position,
                  lastPlayer: sharedState.getLastPlayerWithBall()
                } as any);
              } else {
                // Fallback to old system for other cases
                console.log("Emitting general out-of-bounds event");
                world.emit("ball-reset-out-of-bounds" as any, {} as any);
              }
              
              // Set a short delay before allowing the ball to trigger another out-of-bounds event
              // This prevents rapid whistle sounds if the ball spawns in a weird location
              setTimeout(() => {
                isRespawning = false;
              }, 1000);
            }
          }, 1500);
        }
      }
    }

    // Proximity-based ball possession for better passing mechanics
    if (attachedPlayer == null && !inGoal && !isRespawning && !isInitializing) {
      // Check for nearby teammates when ball is loose
      const ballPosition = entity.position;
      const ballVelocity = entity.linearVelocity;
      
      // Only check for proximity possession if ball is moving slowly or stationary
      const ballSpeed = Math.sqrt(ballVelocity.x * ballVelocity.x + ballVelocity.z * ballVelocity.z);
      const PROXIMITY_POSSESSION_DISTANCE = 1.5; // Distance in units for automatic possession
      const MAX_BALL_SPEED_FOR_PROXIMITY = 3.0; // Only auto-possess if ball is moving slowly
      
      if (ballSpeed < MAX_BALL_SPEED_FOR_PROXIMITY) {
        // Get all player entities in the world
        const allPlayerEntities = world.entityManager.getAllPlayerEntities();
        let closestPlayer: SoccerPlayerEntity | null = null;
        let closestDistance = Infinity;
        
        for (const playerEntity of allPlayerEntities) {
          if (playerEntity instanceof SoccerPlayerEntity && playerEntity.isSpawned && !playerEntity.isStunned) {
            const distance = Math.sqrt(
              Math.pow(playerEntity.position.x - ballPosition.x, 2) +
              Math.pow(playerEntity.position.z - ballPosition.z, 2)
            );
            
            if (distance < PROXIMITY_POSSESSION_DISTANCE && distance < closestDistance) {
              closestDistance = distance;
              closestPlayer = playerEntity;
            }
          }
        }
        
        // Automatically attach ball to closest player if within range
        if (closestPlayer) {
          sharedState.setAttachedPlayer(closestPlayer);
          
          // Play a subtle sound to indicate automatic ball attachment
          new Audio({
            uri: "audio/sfx/soccer/kick.mp3", 
            volume: 0.08,
            loop: false,
          }).play(entity.world as World);
          
          console.log(`Ball automatically attached to ${closestPlayer.player.username} (proximity: ${closestDistance.toFixed(2)} units)`);
        }
      }
    }

    if (attachedPlayer != null) {
      const playerRotation = { ...attachedPlayer.rotation }; // Clone rotation
      const playerPos = { ...attachedPlayer.position }; // Clone position
      const direction = getDirectionFromRotation(playerRotation);
      
      // Calculate ball position with a small offset from player
      const ballPosition = {
        x: playerPos.x - direction.x * 0.7,
        y: playerPos.y - 0.5,
        z: playerPos.z - direction.z * 0.7,
      };

      const currentPos = { ...entity.position }; // Clone ball position
      
      // Simple follow logic
      entity.setPosition(ballPosition);
      entity.setLinearVelocity({ x: 0, y: 0, z: 0 });
      
      // Add ball rotation based on player movement for realistic dribbling effect
      const playerVelocity = attachedPlayer.linearVelocity;
      const playerSpeed = Math.sqrt(playerVelocity.x * playerVelocity.x + playerVelocity.z * playerVelocity.z);
      
      // Only rotate the ball if the player is moving at a reasonable speed
      if (playerSpeed > 0.5) {
        // Calculate rotation speed based on player movement speed
        // Higher speed = faster rotation, simulating ball rolling
        const rotationMultiplier = 2.0; // Adjust this to make rotation faster/slower
        const rotationSpeed = playerSpeed * rotationMultiplier;
        
        // Calculate rotation direction based on movement direction
        // The ball should rotate perpendicular to the movement direction
        const movementDirection = {
          x: playerVelocity.x / playerSpeed,
          z: playerVelocity.z / playerSpeed
        };
        
        // Set angular velocity to make ball rotate as if rolling
        // For forward movement, rotate around the X-axis (perpendicular to movement)
        // For sideways movement, rotate around the Z-axis
        entity.setAngularVelocity({
          x: -movementDirection.z * rotationSpeed, // Negative for correct rotation direction
          y: 0, // No spinning around vertical axis
          z: movementDirection.x * rotationSpeed
        });
      } else {
        // Player is stationary or moving slowly, stop ball rotation
        entity.setAngularVelocity({ x: 0, y: 0, z: 0 });
      }
    }
  });

  soccerBall.on(EntityEvent.ENTITY_COLLISION, ({ entity, otherEntity, started }) => {
    if (started && otherEntity instanceof SoccerPlayerEntity) {
      const currentAttachedPlayer = sharedState.getAttachedPlayer();
      
      if (currentAttachedPlayer == null && !inGoal) {
        // Ball is loose - attach to any player who touches it
        if (!otherEntity.isStunned) {
          sharedState.setAttachedPlayer(otherEntity);
          
          // Play a subtle sound to indicate ball attachment
          new Audio({
            uri: "audio/sfx/soccer/kick.mp3", 
            volume: 0.15,
            loop: false,
          }).play(entity.world as World);
        }
      } else if (currentAttachedPlayer != null) {
        // Ball is currently possessed
        if (otherEntity.isTackling) {
          // Tackling player steals the ball
          sharedState.setAttachedPlayer(null);
          // Apply a basic impulse to the ball
          const direction = getDirectionFromRotation(otherEntity.rotation);
          entity.applyImpulse({
            x: direction.x * 1.0,
            y: 0.3,
            z: direction.z * 1.0,
          });
          // Reset angular velocity to prevent unwanted spinning/backwards movement
          entity.setAngularVelocity({ x: 0, y: 0, z: 0 });
        } else if (currentAttachedPlayer instanceof SoccerPlayerEntity && 
                   currentAttachedPlayer.team === otherEntity.team && 
                   currentAttachedPlayer !== otherEntity) {
          // Teammate collision - transfer possession to teammate
          sharedState.setAttachedPlayer(otherEntity);
          
          // Play a subtle sound to indicate ball transfer
          new Audio({
            uri: "audio/sfx/soccer/kick.mp3", 
            volume: 0.1,
            loop: false,
          }).play(entity.world as World);
          
          console.log(`Ball transferred from ${currentAttachedPlayer.player.username} to teammate ${otherEntity.player.username}`);
        }
      }
    }
  });

  soccerBall.on(EntityEvent.BLOCK_COLLISION, ({ entity, blockType, started }) => {
    if (started) {
      const blocks = [0, 7, 24, 27];
      if(!blocks.includes(blockType.id)) {
        // Realistic soccer ball bounce - maintain forward momentum with slight damping
        const velocity = entity.linearVelocity;
        const dampingFactor = 0.85; // Reduce speed slightly on bounce
        entity.setLinearVelocity({
          x: velocity.x * dampingFactor, // Keep forward momentum, just reduce speed
          y: Math.abs(velocity.y) * 0.6, // Bounce up with reduced height
          z: velocity.z * dampingFactor, // Keep lateral momentum, just reduce speed
        });
        // Reset angular velocity to prevent unwanted spinning from collision
        entity.setAngularVelocity({ x: 0, y: 0, z: 0 });
      }
    }
  });

  return soccerBall;
}
