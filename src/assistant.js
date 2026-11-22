// In-app assistant: sends the conversation to Claude and lets it operate the editor through tools.
// The API key is supplied by the person using the app and never leaves their machine except to call the API.
import Anthropic from '@anthropic-ai/sdk';

export const MODEL = 'claude-opus-5-5';
const MAX_STEPS = 30;

export const SYSTEM = `You are the built-in assistant of Cinematic, an editor for making short 3D cinematics.
The person using it describes what they want in plain words and you carry it out with the tools. They may not know 3D terms, so do the technical work yourself and explain results simply.

How the scene works:
- Units are metres. Y is up. The ground is at y = 0.
- There is one shot camera. Its motion is a list of keyframes (time, position, where it looks, focal length). Longer focal length means a tighter, more zoomed shot: 24 is wide, 35 to 50 is natural, 85 and above is a close-up.
- There is one character ("actor"). If a rigged model is imported it has named bones you can pose; otherwise it is a plain stand-in figure with no bones.
- The timeline has a length in seconds and a frame rate.
- Animations exported from the game can be imported by the person and played on the actor (a sprint loop, a death, a reload). One plays at a time. Any pose you set is an offset layered on top of the playing animation, so the motion continues underneath it.
- The camera can be mounted on a bone so it travels with the character (for example on the weapon hand for a gun-barrel shot). While mounted, camera keys are remembered relative to that bone. It can also stay aimed at a bone, such as the head, wherever it rides.

How to work:
- Call get_scene before changing anything, so your numbers fit the real scene. Call list_bones before posing, to learn bone names and where they are.
- To pose a limb, prefer the "aim" operation: point a bone at a direction in world space. Work from the body outward (shoulder, then elbow, then wrist). Use "rotate" for small adjustments and for curling fingers.
- A pose can change over time: set the playhead, pose the bones, call key_pose, then repeat at another time. For a head turn, key the neutral pose where it starts and the turned pose where it ends.
- After posing or framing a shot, call capture_view to look at the result, and fix what looks wrong before you report back. Check poses from more than one angle.
- For a point-of-view or rig shot, mount the camera first (a preset is the quickest start), then place or key it. Positions you pass to the camera tools are always world positions at the current moment.
- Camera moves read best with few keys: two or three is usually enough. Keep the camera above the ground and outside the character.
- When you are done, say in one or two short sentences what you changed. Mention anything you could not do.
- If a request needs something the tools cannot do, say so plainly instead of approximating it silently.`;

const vec3 = { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 };

export const TOOLS = [
  {
    name: 'get_scene',
    description: 'Read the current state of the editor: playhead time, timeline length and frame rate, the shot camera and its keyframes, sky and lighting settings, the actor, and markers. Call this first.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'set_time',
    description: 'Move the playhead to a time in seconds.',
    input_schema: { type: 'object', properties: { seconds: { type: 'number' } }, required: ['seconds'] },
  },
  {
    name: 'set_timeline',
    description: 'Change the timeline length in seconds and/or the frame rate.',
    input_schema: { type: 'object', properties: { duration: { type: 'number' }, fps: { type: 'number', enum: [24, 30, 60, 120, 240] } } },
  },
  {
    name: 'set_camera',
    description: 'Place the shot camera right now, at the current playhead time. Set key to true to also record a keyframe there.',
    input_schema: {
      type: 'object',
      properties: {
        position: { ...vec3, description: 'Camera position in metres [x, y, z].' },
        look_at: { ...vec3, description: 'Point the camera looks at.' },
        focal_mm: { type: 'number', description: 'Focal length, 12 to 200.' },
        roll_deg: { type: 'number', description: 'Tilt of the horizon, -45 to 45.' },
        key: { type: 'boolean' },
      },
      required: ['position', 'look_at'],
    },
  },
  {
    name: 'set_camera_keys',
    description: 'Write several camera keyframes at once, for a whole camera move. With replace true, existing keys are removed first.',
    input_schema: {
      type: 'object',
      properties: {
        replace: { type: 'boolean' },
        keys: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              time: { type: 'number', description: 'Seconds.' },
              position: vec3,
              look_at: vec3,
              focal_mm: { type: 'number' },
              roll_deg: { type: 'number' },
              ease: { type: 'string', enum: ['auto', 'linear', 'smooth', 'hold'], description: 'How the camera leaves this key. auto eases at the ends of the move and flows through the middle.' },
            },
            required: ['time', 'position', 'look_at'],
          },
        },
      },
      required: ['keys'],
    },
  },
  {
    name: 'delete_camera_keys',
    description: 'Delete camera keyframes at the given times in seconds. Leave times out to delete all of them.',
    input_schema: { type: 'object', properties: { times: { type: 'array', items: { type: 'number' } } } },
  },
  {
    name: 'set_scene',
    description: 'Change the sky and lighting. Only the fields you pass are changed.',
    input_schema: {
      type: 'object',
      properties: {
        time_of_day: { type: 'number', description: 'Hour, 0 to 24. Around 6 is dawn, 12 noon, 18 dusk, 22 night.' },
        sun_heading: { type: 'number', description: 'Compass direction the sun shines from, 0 to 360 degrees.' },
        exposure: { type: 'number', description: 'Overall brightness, 0.2 to 3. 1 is normal.' },
        fog: { type: 'number', description: 'Fog thickness, 0 (off) to 0.15.' },
        weather: { type: 'string', enum: ['clear', 'rain', 'storm', 'snow', 'dust'], description: 'Falling rain, heavy rain, snow or drifting dust. Pair rain with fog and a darker time of day; it streaks with motion blur in renders.' },
      },
    },
  },
  {
    name: 'list_animations',
    description: 'List the animations the person has imported: name, length in seconds, whether it is made to loop, and whether it is usable.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'set_animation',
    description: 'Choose which imported animation plays on the actor and how. Pass name null to stop animating. Only the fields you pass are changed.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: ['string', 'null'] },
        start: { type: 'number', description: 'Time on the timeline, in seconds, where the animation begins.' },
        speed: { type: 'number', description: 'Playback speed, 0.05 to 4. 1 is normal, 0.25 is slow motion.' },
        loop: { type: 'boolean', description: 'Repeat for the rest of the timeline.' },
        then: { type: ['string', 'null'], description: 'A second imported animation that takes over part-way through (for example a death after a sprint), or null for none. It continues from wherever the first has carried the character.' },
        switch_at: { type: 'number', description: 'Time on the timeline, in seconds, when the second animation takes over.' },
        blend: { type: 'number', description: 'Seconds to blend from the first animation into the second, 0 to 2. About 0.2 looks natural for a hit.' },
        keep_above_ground: { type: 'boolean', description: 'True (the default) bends an arm or leg just enough when the animation would sink a hand or foot into the flat ground.' },
        travel: { type: 'boolean', description: 'True lets the animation carry the character across the scene (a sprint covers ground); false keeps it on the spot.' },
      },
    },
  },
  {
    name: 'set_prop',
    description: 'Change a prop the person has imported, such as a weapon: attach it to a bone of the actor (or null to leave it free), and show or hide its parts. A weapon model contains every attachment at once (scopes, suppressor and so on), so hide the ones that should not be on the gun. get_scene lists the loaded props and their parts.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        bone: { type: ['string', 'null'] },
        show: { type: 'array', items: { type: 'string' }, description: 'Part names to show.' },
        hide: { type: 'array', items: { type: 'string' }, description: 'Part names to hide.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'mount_camera',
    description: 'Mount the shot camera on a bone so it rides with the character, or change how it is mounted. Presets place it for you: gun (fixed to the muzzle of the attached weapon, looking back down the barrel at the face; without a weapon prop it rides the weapon hand instead), barrel (fixed on the weapon behind the muzzle, looking where the barrel points; needs a weapon prop), helmet (at the eyes), shoulder (behind the right shoulder), boot (low by the right foot, aimed at the face). preset "none" unmounts it. The camera does not jump when the mount changes.',
    input_schema: {
      type: 'object',
      properties: {
        preset: { type: 'string', enum: ['gun', 'barrel', 'helmet', 'shoulder', 'boot', 'none'] },
        bone: { type: ['string', 'null'], description: 'Bone to ride on, or null to unmount.' },
        look_at_bone: { type: ['string', 'null'], description: 'Bone the camera stays aimed at, or null to aim freely.' },
        keep_level: { type: 'boolean', description: 'True rides the bone position only so the horizon stays level; false also tilts and shakes with the bone.' },
        smoothing: { type: 'number', description: 'Seconds of lag, 0 to 1. 0 is locked rigidly to the bone. 0.05 to 0.15 takes the harsh shake out of a gun or helmet cam; more makes the camera trail behind the movement.' },
      },
    },
  },
  {
    name: 'move_actor',
    description: 'Move the actor on the ground and/or turn it to face a compass heading in degrees.',
    input_schema: { type: 'object', properties: { position: vec3, heading_deg: { type: 'number' } } },
  },
  {
    name: 'add_markers',
    description: 'Add named markers on the timeline.',
    input_schema: {
      type: 'object',
      properties: { markers: { type: 'array', items: { type: 'object', properties: { time: { type: 'number' }, label: { type: 'string' } }, required: ['time', 'label'] } } },
      required: ['markers'],
    },
  },
  {
    name: 'list_bones',
    description: "List the actor's bones: name, parent, and current world position in metres. Fails if the actor has no skeleton.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'pose_bones',
    description: 'Pose the actor by applying operations to bones, in order. aim: turn the bone so the line from it to its child points along a world direction. rotate: turn the bone by degrees around its own x, y, z axes. twist: spin the bone around its own length.',
    input_schema: {
      type: 'object',
      properties: {
        operations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              bone: { type: 'string' },
              op: { type: 'string', enum: ['aim', 'rotate', 'twist'] },
              child: { type: 'string', description: 'For aim and twist: the bone at the far end of this one. Defaults to its first child bone.' },
              direction: { ...vec3, description: 'For aim: world direction, e.g. [0, 1, 0] is straight up.' },
              degrees: { description: 'For rotate: [x, y, z] degrees. For twist: one number.', anyOf: [{ type: 'number' }, vec3] },
            },
            required: ['bone', 'op'],
          },
        },
      },
      required: ['operations'],
    },
  },
  {
    name: 'set_focus',
    description: 'Depth of field for the shot camera: how blurred things in front of and behind the focus are, and what stays sharp. Only the fields you pass change. Focus either follows a bone (stays sharp on it as it moves) or sits at a distance in metres. For a focus pull, go to the first time and call with a bone or distance and key: true, then go to the second time and do the same: the focus eases between the keys. It shows in test renders and the render queue, not the live view; capture_view does not show it.',
    input_schema: {
      type: 'object',
      properties: {
        blur: { type: 'number', description: '0 (off, everything sharp) to 10. Around 3 is a gentle film look at a few metres; close-up camera mounts need 1 or less.' },
        bone: { type: 'string', description: 'Bone to keep sharp, e.g. j_head. Empty string to stop following a bone.' },
        distance: { type: 'number', description: 'Metres in front of the camera that are sharp.' },
        key: { type: 'boolean', description: 'Store the current focus distance (or the bone\'s current distance) as a key at the playhead.' },
        clear_keys: { type: 'boolean', description: 'Remove all focus keys.' },
      },
    },
  },
  {
    name: 'key_pose',
    description: 'Keep the current pose as a key at a time (the playhead if time is left out). With two or more pose keys the pose changes over time, easing from each key to the next, on top of the playing animation. Pose the bones first, then key.',
    input_schema: { type: 'object', properties: { time: { type: 'number', description: 'Seconds on the timeline.' } } },
  },
  {
    name: 'delete_pose_keys',
    description: 'Delete pose keys at the given times in seconds. Leave times out to delete all of them.',
    input_schema: { type: 'object', properties: { times: { type: 'array', items: { type: 'number' } } } },
  },
  {
    name: 'reset_pose',
    description: 'Return bones to the pose the model was imported in. Leave bones out to reset the whole skeleton.',
    input_schema: { type: 'object', properties: { bones: { type: 'array', items: { type: 'string' } } } },
  },
  {
    name: 'capture_view',
    description: 'Take a picture of the scene so you can check your work. view "camera" looks through the shot camera at the playhead. view "custom" looks from a point you choose, for inspecting a pose from the front, side or above.',
    input_schema: {
      type: 'object',
      properties: { view: { type: 'string', enum: ['camera', 'custom'] }, from: vec3, at: vec3 },
      required: ['view'],
    },
  },
];

export function createClient(apiKey) {
  // The key belongs to the person running the app on their own machine, so calling the API from the app itself is intended.
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
}

/** Turn an SDK error into a sentence for the chat log. */
export function describeError(err) {
  if (err instanceof Anthropic.APIUserAbortError) return 'Stopped.';
  if (err instanceof Anthropic.AuthenticationError) return 'The API key was rejected. Check it and save it again.';
  if (err instanceof Anthropic.PermissionDeniedError) return 'This API key is not allowed to use that model.';
  if (err instanceof Anthropic.RateLimitError) return 'Rate limited. Wait a moment and try again.';
  if (err instanceof Anthropic.BadRequestError) return `The request was rejected: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return 'Could not reach the API. Check your internet connection.';
  if (err instanceof Anthropic.APIError) return `The API returned an error (${err.status}): ${err.message}`;
  return `Something went wrong: ${err?.message || err}`;
}

/**
 * Run one request from the person through to a finished reply, executing tool calls along the way.
 * `messages` is the running conversation and is appended to in place.
 * `execute(name, input)` performs a tool call and returns a string or an array of content blocks.
 * `onEvent` receives { type: 'text' | 'tool' | 'notice', ... } as things happen.
 */
export async function runTurn({ client, messages, execute, onEvent, signal }) {
  for (let step = 0; step < MAX_STEPS; step++) {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',                       // if the model declines, the API retries on a fallback model
      output_config: { effort: 'medium' },
      cache_control: { type: 'ephemeral' },       // the conversation is resent each step; cache the shared prefix
      system: SYSTEM,
      tools: TOOLS,
      messages,
    }, { signal });

    messages.push({ role: 'assistant', content: response.content });
    for (const block of response.content) {
      if (block.type === 'text' && block.text.trim()) onEvent({ type: 'text', text: block.text });
    }

    if (response.stop_reason === 'refusal') {
      onEvent({ type: 'notice', text: 'The assistant declined this request.' });
      return response;
    }
    if (response.stop_reason === 'max_tokens') {
      onEvent({ type: 'notice', text: 'The reply was cut off for length. Ask it to continue.' });
      return response;
    }
    if (response.stop_reason === 'pause_turn') continue;

    const calls = response.content.filter((b) => b.type === 'tool_use');
    if (response.stop_reason !== 'tool_use' || !calls.length) return response;

    // Every tool result for this step goes back in a single user message.
    const results = [];
    for (const call of calls) {
      onEvent({ type: 'tool', name: call.name, input: call.input });
      try {
        results.push({ type: 'tool_result', tool_use_id: call.id, content: await execute(call.name, call.input) });
      } catch (err) {
        results.push({ type: 'tool_result', tool_use_id: call.id, content: String(err?.message || err), is_error: true });
      }
    }
    messages.push({ role: 'user', content: results });
  }
  onEvent({ type: 'notice', text: `Stopped after ${MAX_STEPS} steps. Ask it to continue if the job is not finished.` });
  return null;
}
