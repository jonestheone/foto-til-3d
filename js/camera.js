/**
 * camera.js – tag et billede med computerens webcam.
 * (På mobilen bruger appen i stedet telefonens egen kamera-app, som giver bedre billeder.)
 *
 * Returnerer et JPEG-billede (Blob), eller null hvis man trykker Annuller.
 * Kaster en fejl hvis kameraet ikke kan åbnes (fx hvis man ikke giver adgang).
 */
export async function openWebcam() {
  const dialog = document.getElementById('cam-dialog');
  const video = document.getElementById('cam-video');
  const btnShoot = document.getElementById('cam-shoot');
  const btnCancel = document.getElementById('cam-cancel');
  const btnSwitch = document.getElementById('cam-switch');

  let stream = null;
  const stop = () => {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    video.srcObject = null;
  };
  const start = async (deviceId) => {
    stop();
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'environment' }),
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    });
    video.srcObject = stream;
    await video.play().catch(() => {});
  };

  await start(); // fejl sendes videre til main.js, som viser en besked

  const cameras = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  const currentId = stream?.getVideoTracks()[0]?.getSettings().deviceId;
  let camIndex = Math.max(0, cameras.findIndex((c) => c.deviceId === currentId));
  btnSwitch.hidden = cameras.length < 2;
  dialog.showModal();

  return new Promise((resolve) => {
    let done = false;
    const finish = (blob) => {
      if (done) return;
      done = true;
      btnShoot.removeEventListener('click', onShoot);
      btnCancel.removeEventListener('click', onCancel);
      btnSwitch.removeEventListener('click', onSwitch);
      dialog.removeEventListener('cancel', onCancel);
      stop();
      if (dialog.open) dialog.close();
      resolve(blob);
    };
    const onShoot = () => {
      if (!video.videoWidth) return;
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d').drawImage(video, 0, 0);
      canvas.toBlob((blob) => finish(blob), 'image/jpeg', 0.92);
    };
    const onCancel = (e) => {
      e?.preventDefault();
      finish(null);
    };
    const onSwitch = async () => {
      camIndex = (camIndex + 1) % cameras.length;
      try {
        await start(cameras[camIndex].deviceId);
      } catch (err) {
        console.warn('Kunne ikke skifte kamera', err);
      }
    };
    btnShoot.addEventListener('click', onShoot);
    btnCancel.addEventListener('click', onCancel);
    btnSwitch.addEventListener('click', onSwitch);
    dialog.addEventListener('cancel', onCancel); // Esc-tasten
  });
}
