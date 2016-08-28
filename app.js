var bpm = 120;
var volume;
var playIndex;
var startTime;
var loop_length = 16;
// var lastDrawTime = -1;
var noteTime;
console.log(loop_length);
var kick;
var snare;
var hat;
var rec;
var gain;

var SCConnected = false;

// const gain = context.createGain();              // CREATE GAIN NODE
// oscillator.connect(gain);
// gain.connect(context.destination);

var context;
var bufferLoader;

var instruments = ['lead','bass','closedhat','snare','kick']
var currentState = {};



////////////////////////////////////////////////////////////////////////////////
////////////      DOCUMENT READY       /////////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////
$(document).ready(function() {
  $('#samplesLoading').show();
  $('#container').hide();
  init();
  playStopListener();
  // stopListener();
  console.log("context.currentTime" + context.currentTime);
  var recorderObj = {
      // context: context,
      source: gain
  };
  recorder = new SC.Recorder(recorderObj);
  upload = new SC.upload();
})

function init() {
  // if (window.hasOwnProperty('AudioContext') && !window.hasOwnProperty('webkitAudioContext')) {
  //   window.webkitAudioContext = AudioContext;
  // }
  context = new webkitAudioContext();
  // context = new AudioContext();
  context.number
  gain = context.createGain();
  gain.connect(context.destination);
  bufferLoader = new BufferLoader(
    context,
    [
      '../kick.wav',
      '../snare.wav',
      '../closedhat.wav',
      '../lead.wav',
      '../bass.wav'
    ],
    finishedLoading
    );
  bufferLoader.load();
}

function finishedLoading(bufferList) {
  kickBuffer = bufferList[0];
  snareBuffer = bufferList[1];
  hatBuffer = bufferList[2];
  leadBuffer = bufferList[3];
  bassBuffer = bufferList[4];
  $('#samplesLoading').hide();
  $('#container').show();
}

////////////////////////////////////////////////////////////////////////////////
////////////      PLAY/STOP       //////////////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////
// function playSound(sourceBuffer) {
//   var source = context.createBufferSource();
//   source.buffer = sourceBuffer;
//   source.connect(context.destination);
//   source.start(0);
// }

function playSound(sourceBuffer) {
  var source = context.createBufferSource();
  source.buffer = sourceBuffer;
  source.connect(gain);
  source.start(0);
}

function playStopListener() {
  $('.playStop').click(function(e) {
    if ($(e.target).hasClass('fa-play')) {
      // $(e.target).removeClass('fa-play').addClass('fa-stop');
      startPlay();
    } else {
      // $(e.target).removeClass('fa-stop').addClass('fa-play');
      stopPlay();
    }
    $(e.target).toggleClass('fa-play fa-stop');
  });
}

// function stopListener(){
//   $('#play-stop').click(function(){
//     stopPlay();
//   })
// }

function startPlay(event) {
  playIndex = 0;
  noteTime = 0.0;
  startTime = context.currentTime + 0.010;
  // startTime = context.currentTime;
  schedule();
}

function stopPlay(event) {
  cancelAnimationFrame(timeoutId);
  $(".cell").removeClass("playing");
}

function schedule() {
  var currentTime = context.currentTime;
  currentTime -= startTime;
  while (noteTime < currentTime + 0.200) {
    var $currentCells = $(".column_" + playIndex);
    $currentCells.each(function() {
      if ($(this).hasClass("active") && $(this).hasClass("kick")) {
        playSound(kickBuffer);
      }
      if ($(this).hasClass("active") && $(this).hasClass("snare")) {
        playSound(snareBuffer);
      }
      if ($(this).hasClass("active") && $(this).hasClass("hat")) {
        playSound(hatBuffer);
      }
      if ($(this).hasClass("active") && $(this).hasClass("lead")) {
        playSound(leadBuffer);
      }
      if ($(this).hasClass("active") && $(this).hasClass("bass")) {
        playSound(bassBuffer);
      }
    })
    // if (noteTime != lastDrawTime) {
    //     lastDrawTime = noteTime;
        drawPlayhead(playIndex);
    // }
    advanceNote();
  }
  timeoutId = requestAnimationFrame(schedule);
}

function drawPlayhead(xindex) {
    var lastIndex = (xindex + loop_length - 1) % loop_length;
    var $newRows = $('.column_' + xindex);
    var $oldRows = $('.column_' + lastIndex);

    $newRows.addClass("playing");
    $oldRows.removeClass("playing");
}

function advanceNote() {
    var secondsPerBeat = 60.0 / bpm;
    playIndex++;
    if (playIndex == loop_length) {  // when playIndex reaches the end of the loop,
        playIndex = 0;               // return to index 0
    }
    //0.25 because each square is a 16th note
    noteTime += 0.25 * secondsPerBeat
}

// var oscillator = context.createOscillator();
// oscillator.connect(context.destination);
// const gain = context.createGain();              // CREATE GAIN NODE
// oscillator.connect(gain);
// gain.connect(context.destination);              // CONNECT GAIN NODE TO DESTINATION
// oscillator.start(0);
// oscillator.stop(context.currentTime + 2);
////////////////////////////////////////////////////////////////////////////////
////////////      TODO CODE FOR SETTING LOOP_LENGTH       //////////////////////
////////////////////////////////////////////////////////////////////////////////



////////////////////////////////////////////////////////////////////////////////
////////////      VOLUME SLIDER       //////////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////
document.getElementById('volume-slider').addEventListener('change', function(){
  gain.gain.value = parseFloat(this.value);
  console.log(gain.gain.value);
})
////////////////////////////////////////////////////////////////////////////////
////////////      EVENT LISTENERS TO ACTIVATE/DEACTIVATE CELLS       ///////////
////////////////////////////////////////////////////////////////////////////////
function reset(){
  $('.cell').removeClass('active');
}

$('#reset').click(function(){
  reset();
});

var cells = document.getElementsByClassName('cell');

for (var i = 0; i < cells.length; i++) {
  cells[i].addEventListener('click', function(event){
  // console.log(event.target);
    if(this.classList.contains('active')){
      this.classList.remove('active');
    } else {
      this.classList.add('active')
    }
  })
};

////////////////////////////////////////////////////////////////////////////////
////////////      EVENT LISTENERS FOR LOCAL STORAGE       //////////////////////
////////////////////////////////////////////////////////////////////////////////
function localStorageSupported() {
 try {
  return "localStorage" in window && window["localStorage"] !== null;
 } catch (e) {
  return false;
 }
}


function saveInstrument(name) {
  if (!currentState[name]) {
    console.log('adding value');
    currentState[name] = [];
  }
  var array = $('#' + name).children('.cell');
  for (var i = 0; i < array.length; i++) {
    currentState[name][i] = $(array[i]).hasClass('active');
  }
}

function loadInstrument(name){
  if (!currentState[name]) return;
  var array = $('#' + name).children('.cell');
  for (var i = 0; i < array.length; i++) {
    if (currentState[name][i]) {
      $(array[i]).addClass('active');
    }
    else {
      $(array[i]).removeClass('active');
    }
  }
}

function saveState(){
  for (var i = 0; i < instruments.length; i++) {
    saveInstrument(instruments[i]);
  }
  console.log(currentState);
  return JSON.stringify(currentState);
}

function loadState(pattern){
  // for pattern
  if (pattern) {
    currentState = JSON.parse(pattern)
  }
  for (var i = 0; i < instruments.length; i++) {
    loadInstrument(instruments[i]);
  }
}

////////////////////////////////////////////////////////////////////////////////
////////////      EVENT LISTENERS FOR BOTTOM PANEL       ///////////////////////
////////////////////////////////////////////////////////////////////////////////
$('#save').click(function(){
  $('#savePanel').show();
  $('#save').addClass('selectedPanel');
  $('#save').removeClass('deselectedPanel');
  $('#loadPanel').hide();
  $('#load').addClass('deselectedPanel');
  $('#load').removeClass('selectedPanel');
  $('#recordPanel').hide();
  $('#record').addClass('deselectedPanel');
  $('#record').removeClass('selectedPanel');
  console.log('save');
});
$('#load').click(function(){
  $('#savePanel').hide();
  $('#save').addClass('deselectedPanel');
  $('#save').removeClass('selectedPanel');
  $('#loadPanel').show();
  $('#load').addClass('selectedPanel');
  $('#load').removeClass('deselectedPanel');
  $('#recordPanel').hide();
  $('#record').addClass('deselectedPanel');
  $('#record').removeClass('selectedPanel');
  console.log('load');
});
$('#record').click(function(){
  $('#savePanel').hide();
  $('#save').addClass('deselectedPanel');
  $('#save').removeClass('selectedPanel');
  $('#loadPanel').hide();
  $('#load').addClass('deselectedPanel');
  $('#load').removeClass('selectedPanel');
  $('#recordPanel').show();
  $('#record').addClass('selectedPanel');
  $('#record').removeClass('deselectedPanel');
  console.log('record');
  // $('#recordStart').click(function(){
    if (!SCConnected) {
      SC.connect().then(function(){
        return SC.get('/me');
      }).then(function(user){
          SCConnected = true;
      })
    }
});

$('#savePattern1').click(function(){
  localStorage.setItem('pattern1', saveState());
});
$('#savePattern2').click(function(){
  localStorage.setItem('pattern2', saveState());
});
$('#savePattern3').click(function(){
  localStorage.setItem('pattern3', saveState());
});
$('#savePattern4').click(function(){
  localStorage.setItem('pattern4', saveState());
});

$('#loadPattern1').click(function(){
  loadState(localStorage.pattern1);
});
$('#loadPattern2').click(function(){
  loadState(localStorage.pattern2);
});
$('#loadPattern3').click(function(){
  loadState(localStorage.pattern3);
});
$('#loadPattern4').click(function(){
  loadState(localStorage.pattern4);
});
